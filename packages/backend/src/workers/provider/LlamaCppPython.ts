/**********************************************************************
 * Copyright (C) 2024 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/
import type {
  ContainerCreateOptions,
  ContainerProviderConnection,
  DeviceRequest,
  ImageInfo,
  MountConfig,
} from '@podman-desktop/api';
import type { InferenceServerConfig } from '@shared/models/InferenceServerConfig';
import { InferenceProvider } from './InferenceProvider';
import { getModelPropertiesForEnvironment, getMountPath } from '../../utils/modelsUtils';
import { DISABLE_SELINUX_LABEL_SECURITY_OPTION } from '../../utils/utils';
import { LABEL_INFERENCE_SERVER } from '../../utils/inferenceUtils';
import type { TaskRegistry } from '../../registries/TaskRegistry';
import { type InferenceServer, InferenceType } from '@shared/models/IInference';
import type { GPUManager } from '../../managers/GPUManager';
import { GPUVendor, type IGPUInfo } from '@shared/models/IGPUInfo';
import { VMType } from '@shared/models/IPodman';
import type { PodmanConnection } from '../../managers/podmanConnection';
import type { ConfigurationRegistry } from '../../registries/ConfigurationRegistry';
import { llamacpp } from '../../assets/inference-images.json';
import * as fs from 'node:fs';

export const SECOND: number = 1_000_000_000;

interface Device {
  PathOnHost: string;
  PathInContainer: string;
  CgroupPermissions: string;
}

export class LlamaCppPython extends InferenceProvider {
  constructor(
    taskRegistry: TaskRegistry,
    private podmanConnection: PodmanConnection,
    private gpuManager: GPUManager,
    private configurationRegistry: ConfigurationRegistry,
  ) {
    super(taskRegistry, InferenceType.LLAMA_CPP, 'LLama-cpp');
  }

  dispose(): void {}

  public enabled = (): boolean => true;

  protected async getContainerCreateOptions(
    config: InferenceServerConfig,
    imageInfo: ImageInfo,
    vmType: VMType,
    gpu?: IGPUInfo,
  ): Promise<ContainerCreateOptions> {
    if (config.modelsInfo.length === 0) throw new Error('Need at least one model info to start an inference server.');

    if (config.modelsInfo.length > 1) {
      throw new Error('Currently the inference server does not support multiple models serving.');
    }

    const modelInfo = config.modelsInfo[0];

    if (modelInfo.file === undefined) {
      throw new Error('The model info file provided is undefined');
    }

    const labels: Record<string, string> = {
      ...config.labels,
      [LABEL_INFERENCE_SERVER]: JSON.stringify(config.modelsInfo.map(model => model.id)),
    };

    // get model mount settings
    const filename = getMountPath(modelInfo);
    const target = `/models/${modelInfo.file.file}`;

    // mount the file directory to avoid adding other files to the containers
    const mounts: MountConfig = [
      {
        Target: target,
        Source: filename,
        Type: 'bind',
      },
    ];

    // provide envs
    const envs: string[] = [`MODEL_PATH=${target}`, 'HOST=0.0.0.0', 'PORT=8000'];
    envs.push(...getModelPropertiesForEnvironment(modelInfo));

    const deviceRequests: DeviceRequest[] = [];
    const devices: Device[] = [];
    let entrypoint: string | undefined = undefined;
    let cmd: string[] = [];
    let user: string | undefined = undefined;

    if (gpu) {
      let supported: boolean = false;
      switch (vmType) {
        case VMType.WSL:
          // WSL Only support NVIDIA
          if (gpu.vendor !== GPUVendor.NVIDIA) break;

          supported = true;
          mounts.push({
            Target: '/usr/lib/wsl',
            Source: '/usr/lib/wsl',
            Type: 'bind',
          });

          devices.push({
            PathOnHost: '/dev/dxg',
            PathInContainer: '/dev/dxg',
            CgroupPermissions: 'r',
          });

          user = '0';

          entrypoint = '/usr/bin/sh';
          cmd = [
            '-c',
            '/usr/bin/ln -sfn /usr/lib/wsl/lib/* /usr/lib64/ && PATH="${PATH}:/usr/lib/wsl/lib/" && /usr/bin/llama-server.sh',
          ];
          break;
        case VMType.LIBKRUN:
        case VMType.LIBKRUN_LABEL:
          supported = true;
          devices.push({
            PathOnHost: '/dev/dri',
            PathInContainer: '/dev/dri',
            CgroupPermissions: '',
          });
          break;
        case VMType.UNKNOWN:
          // This is linux with podman locally installed

          // Linux GPU support currently requires NVIDIA GPU with CDI configured
          if (!this.isNvidiaCDIConfigured(gpu)) break;

          supported = true;
          devices.push({
            PathOnHost: 'nvidia.com/gpu=all',
            PathInContainer: '',
            CgroupPermissions: '',
          });

          user = '0';

          break;
      }

      // adding gpu capabilities in supported architectures
      if (supported) {
        deviceRequests.push({
          Capabilities: [['gpu']],
          Count: -1, // -1: all
        });

        // label the container
        labels['gpu'] = gpu.model;
        envs.push(`GPU_LAYERS=${config.gpuLayers ?? 999}`);
      } else {
        console.warn(`gpu ${gpu.model} is not supported on ${vmType}.`);
      }
    }

    // add the link to our openAPI instance using the instance as the host
    const aiLabPort = this.configurationRegistry.getExtensionConfiguration().apiPort;
    // add in the URL the port of the inference server
    const aiLabDocsLink = `http://localhost:${aiLabPort}/api-docs/${config.port}`;
    // adding labels to inference server
    labels['docs'] = aiLabDocsLink;
    labels['api'] = `http://localhost:${config.port}/v1`;

    return {
      Image: imageInfo.Id,
      Detach: true,
      Entrypoint: entrypoint,
      User: user,
      ExposedPorts: { [`${config.port}`]: {} },
      HostConfig: {
        AutoRemove: false,
        Devices: devices,
        Mounts: mounts,
        DeviceRequests: deviceRequests,
        SecurityOpt: [DISABLE_SELINUX_LABEL_SECURITY_OPTION],
        PortBindings: {
          '8000/tcp': [
            {
              HostPort: `${config.port}`,
            },
          ],
        },
      },
      HealthCheck: {
        // must be the port INSIDE the container not the exposed one
        Test: ['CMD-SHELL', `curl -sSf localhost:8000 > /dev/null`],
        Interval: SECOND * 5,
        Retries: 4 * 5,
      },
      Labels: labels,
      Env: envs,
      Cmd: cmd,
    };
  }

  async perform(config: InferenceServerConfig): Promise<InferenceServer> {
    if (!this.enabled()) throw new Error('not enabled');

    let gpu: IGPUInfo | undefined = undefined;

    // get the first GPU if option is enabled
    if (this.configurationRegistry.getExtensionConfiguration().experimentalGPU) {
      const gpus: IGPUInfo[] = await this.gpuManager.collectGPUs();
      if (gpus.length === 0) throw new Error('no gpu was found.');

      // Look for a GPU that is of a known type, use the first one found.
      // Fall back to the first one if no GPUs are of known type.
      gpu = gpus.find(({ vendor }) => vendor !== GPUVendor.UNKNOWN) ?? gpus[0];
    }

    let connection: ContainerProviderConnection | undefined = undefined;
    if (config.connection) {
      connection = this.podmanConnection.getContainerProviderConnection(config.connection);
    } else {
      connection = this.podmanConnection.findRunningContainerProviderConnection();
    }

    if (!connection) throw new Error('no running connection could be found');

    const vmType: VMType = (connection.vmType ?? VMType.UNKNOWN) as VMType;

    // pull the image
    const imageInfo: ImageInfo = await this.pullImage(
      connection,
      config.image ?? this.getLlamaCppInferenceImage(vmType, gpu),
      config.labels,
    );

    // Get the container creation options
    const containerCreateOptions: ContainerCreateOptions = await this.getContainerCreateOptions(
      config,
      imageInfo,
      vmType,
      gpu,
    );

    // Create the container
    const { engineId, id } = await this.createContainer(imageInfo.engineId, containerCreateOptions, config.labels);

    return {
      container: {
        engineId: engineId,
        containerId: id,
      },
      connection: {
        port: config.port,
      },
      status: 'running',
      models: config.modelsInfo,
      type: InferenceType.LLAMA_CPP,
      labels: containerCreateOptions.Labels ?? {},
    };
  }

  protected getLlamaCppInferenceImage(vmType: VMType, gpu?: IGPUInfo): string {
    switch (vmType) {
      case VMType.WSL:
        return gpu?.vendor === GPUVendor.NVIDIA ? llamacpp.cuda : llamacpp.default;
      case VMType.LIBKRUN:
      case VMType.LIBKRUN_LABEL:
        return llamacpp.default;
      // no GPU support
      case VMType.UNKNOWN:
        return this.isNvidiaCDIConfigured(gpu) ? llamacpp.cuda : llamacpp.default;
      default:
        return llamacpp.default;
    }
  }

  protected isNvidiaCDIConfigured(gpu?: IGPUInfo): boolean {
    // NVIDIA cdi must be set up to use GPU acceleration on Linux.
    // Check the known locations for the configuration file
    const knownLocations = [
      '/etc/cdi/nvidia.yaml', // Fedora
    ];

    if (gpu?.vendor !== GPUVendor.NVIDIA) return false;

    let cdiSetup = false;
    for (const location of knownLocations) {
      if (fs.existsSync(location)) {
        cdiSetup = true;
        break;
      }
    }
    return cdiSetup;
  }
}

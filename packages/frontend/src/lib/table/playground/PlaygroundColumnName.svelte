<script lang="ts">
import { router } from 'tinro';
import type { Conversation } from '@shared/models/IPlaygroundMessage';

export let object: Conversation;

function openDetails(): void {
  router.goto(`/playground/${object.id}`);
}
</script>

<button on:click={openDetails}>
  <div class="text-[var(--pd-table-body-text-highlight)] overflow-hidden text-ellipsis">
    {object.name}
  </div>
</button>

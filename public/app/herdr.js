export function herdrMetadata(envelope = {}) {
  const snapshot = envelope.result?.snapshot || {};
  const workspace = focused(snapshot.workspaces, snapshot.focused_workspace_id, 'workspace_id');
  const tab = focused(snapshot.tabs, snapshot.focused_tab_id || workspace?.active_tab_id, 'tab_id');
  const pane = focused(snapshot.panes, snapshot.focused_pane_id, 'pane_id');

  return {
    label: tab?.label || workspace?.label || 'Unlabeled session',
    status: pane?.agent_status || tab?.agent_status || workspace?.agent_status || 'unknown',
  };
}

function focused(items, id, key) {
  return items?.find((item) => item[key] === id) || items?.find((item) => item.focused);
}

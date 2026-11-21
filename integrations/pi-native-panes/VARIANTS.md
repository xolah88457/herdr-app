# Pi subagents: choose one transport at launch

The two extensions expose the same subagent tools. The native Herdr variant starts workers in background Herdr tabs by default, or in splits beside their parent when `pi-subagents.split` is on. The original tmux variant starts workers in tmux panes. Use the loaded `subagent` tool; do not launch tmux yourself, load the other extension, or deploy a second worker to check the first. To change transport, start a new Pi subagents session from Herdr after changing the setting.

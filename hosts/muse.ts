import { defineHost, GBRAIN_RESOLVERS } from './define-host';

// Muse Code (fork host, CyberBrown/gstack). Global skills live under
// ~/.config/muse/skills, workspace skills under .agents/skills. Literal
// ~/.config/muse paths (the agy model) so skills without the preamble still
// resolve; .source-path (written by setup) lets /gstack-upgrade find the
// checkout behind the runtime root.
const muse = defineHost({
  name: 'muse',
  displayName: 'Muse Code',
  tier: 'experimental',

  globalRoot: '.config/muse/skills/gstack',
  localSkillRoot: '.agents/skills/gstack',
  // Render output only: .agents is Codex's render tree.
  hostSubdir: '.muse',

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: null,
    nameMatchesDirectory: true,
  },

  pathRewrites: [
    { from: 'if [ -d "$HOME/.claude/skills/gstack/.git" ]', to: 'if [ -d "$(cat "$HOME/.config/muse/skills/gstack/.source-path" 2>/dev/null)/.git" ]' },
    { from: 'INSTALL_DIR="$HOME/.claude/skills/gstack"', to: 'INSTALL_DIR="$(cat "$HOME/.config/muse/skills/gstack/.source-path")"' },
    { from: '$HOME/.claude/skills/gstack', to: '$HOME/.config/muse/skills/gstack' },
    { from: '~/.claude/skills/gstack', to: '~/.config/muse/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.agents/skills/gstack' },
    { from: '.claude/skills/review', to: '.agents/skills/gstack/review' },
    { from: '.claude/skills', to: '.agents/skills' },
  ],
  toolRewrites: {
    'use the Bash tool': 'run this command',
    'use the Write tool': 'create this file',
    'use the Read tool': 'read the file',
    'use the Edit tool': 'edit the file',
    'use the Agent tool': 'dispatch a subagent',
    'use the Grep tool': 'search for',
    'use the Glob tool': 'find files matching',
  },

  suppressedResolvers: ['REVIEW_ARMY', ...GBRAIN_RESOLVERS],

  runtimeRoot: {
    globalSymlinks: ['bin', 'lib', 'browse/dist', 'browse/bin', 'design/dist', 'make-pdf/dist', 'freeze/bin', 'careful/bin', 'gstack-upgrade', 'ETHOS.md'],
    globalFiles: {
      'review': ['checklist.md', 'design-checklist.md', 'greptile-triage.md', 'TODOS-format.md'],
    },
  },
});

export default muse;

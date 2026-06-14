// Per-tool verify spec (loaded by `greenlight verify`). Plain object so the tool
// needs no framework import; the CLI validates the shape.
export default {
  mode: 'mcp',
  expectTools: ['ping'],
  call: { name: 'ping' },
};

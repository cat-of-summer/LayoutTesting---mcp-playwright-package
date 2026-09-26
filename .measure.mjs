process.env.LT_UPDATE_CHECK = '0';
const { createServer } = await import('./src/server.js');
const { resolveSelection } = await import('./src/tools/groups.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
for (const spec of ['all', 'design', 'core', 'minimal']) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const s = await createServer({ selection: resolveSelection(spec) });
  await s.connect(b);
  const c = new Client({ name: 'm', version: '1' });
  await c.connect(a);
  const { tools } = await c.listTools();
  console.log(spec, 'tools', tools.length, 'total', JSON.stringify(tools).length);
}
process.exit(0);

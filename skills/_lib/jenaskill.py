# Helpers every Jena skill can import: read input, answer, call MCP servers. Skills run as Jena's own
# unix user on her box, with a timeout; whatever they print as their LAST line (JSON) is their result.
import asyncio, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
MCP_CONF = os.path.join(os.path.dirname(HERE), '_mcp.json')

def inp():
    try: return json.loads(sys.stdin.read() or '{}')
    except Exception: return {}

def done(ok=True, summary='', **data):
    print(json.dumps({'ok': ok, 'summary': summary, **data}, ensure_ascii=False)[:20000])
    sys.exit(0)

def mcp_servers():
    conf = json.load(open(MCP_CONF))
    home = os.path.expanduser('~')
    for k, v in conf.items():
        v['command'] = v['command'].replace('~', home)
        v['args'] = [a.replace('~', home) for a in v.get('args', [])]
    return conf

async def _mcp(server, tool=None, args=None, timeout=40):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    s = mcp_servers()[server]
    p = StdioServerParameters(command=s['command'], args=s['args'], env={**os.environ}, cwd=os.path.expanduser('~'))
    async with stdio_client(p) as (r, w):
        async with ClientSession(r, w) as sess:
            await asyncio.wait_for(sess.initialize(), timeout)
            if tool is None:
                tl = await sess.list_tools()
                return [{'name': t.name, 'description': (t.description or '')[:160]} for t in tl.tools]
            allow = s.get('allow')
            if allow is not None and tool not in allow:
                return {'error': True, 'text': f'{tool} is blocked for Jena on the {server} MCP server (allowed: {", ".join(allow)})'}
            res = await asyncio.wait_for(sess.call_tool(tool, args or {}), timeout)
            out = []
            for c in res.content:
                out.append(getattr(c, 'text', None) or str(c))
            return {'error': bool(getattr(res, 'isError', False)), 'text': '\n'.join(out)}

def mcp(server, tool=None, args=None, timeout=40):
    return asyncio.run(_mcp(server, tool, args, timeout))

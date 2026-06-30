# Pacifica MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[Pacifica](https://pacifica.fi) perpetual-futures exchange. It exposes Pacifica's
REST API — market data, account and position queries, and full order management —
as MCP tools, so an MCP client such as Claude Desktop can read the markets and
place trades on your behalf.

## Getting started

### Prerequisites

- **Node.js 18 or newer**
- A **Pacifica account address** (your main account or a subaccount)
- For trading (optional): a signing key — either your main wallet's secret key
  or, recommended, a revocable **agent key** bound to your account

### Install (Claude Desktop)

Open Claude Desktop → **Settings → Developer → Edit Config** and add the server
to `claude_desktop_config.json`. The `npx -y` command downloads and runs the
latest published version automatically, so there is no manual install step.

```json
{
  "mcpServers": {
    "pacifica": {
      "command": "npx",
      "args": ["-y", "@pacifica-fi/mcp-server"],
      "env": {
        "ADDRESS": "<your Solana account address>",
        "AGENT_PRIVATE_KEY": "<your base58 agent wallet secret key>"
      }
    }
  }
}
```

Restart Claude Desktop after saving. On startup the server logs the active account
and auth mode to stderr (visible in the MCP logs), e.g.
`[pacifica-mcp] account=<address> mode=agent-key`.

> **Network:** by default the server targets the Pacifica **testnet**
> (`https://test-api.pacifica.fi`). To trade on production, set
> `PACIFICA_BASE_URL=https://api.pacifica.fi` (see the table below).

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ADDRESS` | yes | Public address the actions apply to — your main account or a subaccount. Sent as the `account` field. |
| `PRIVATE_KEY` | no | Base58 Solana secret key (Ed25519) of the main account. Signs POST requests when no agent key is set. |
| `AGENT_PRIVATE_KEY` | no | Base58 secret key of an API **agent wallet** (revocable). When set, signs POST requests and sends `agent_wallet`, so you never expose your main key. The agent must already be bound to `ADDRESS`. Takes precedence over `PRIVATE_KEY`. |
| `AGENT_WALLET` | no | Agent wallet public key. Defaults to the value derived from `AGENT_PRIVATE_KEY`; only set this to override. |
| `PACIFICA_BASE_URL` | no | API host. Defaults to testnet `https://test-api.pacifica.fi`. Set to `https://api.pacifica.fi` for production. |

## Modes

The server picks a mode from the keys you provide:

- **Read-only** — set only `ADDRESS`. All read (GET) tools work; write (POST) tools
  return a clear "read-only mode" error.
- **Agent-key (recommended)** — set `ADDRESS` + `AGENT_PRIVATE_KEY`. Full trading
  without ever putting your main wallet's private key in the config.
- **Main-key** — set `ADDRESS` + `PRIVATE_KEY`. Full trading, signing with the main
  wallet key (legacy behavior).

### Recommended: agent key

An agent key is a revocable key bound to your account: it can trade, but it cannot
move funds the way your main wallet can, and you can revoke it at any time. Generate
and bind one once at [app.pacifica.fi/apikey](https://app.pacifica.fi/apikey) — you
sign the binding in-browser, so your main secret never leaves your wallet. Then
configure the MCP with only your account address and the agent key:

```json
{
  "mcpServers": {
    "pacifica": {
      "command": "npx",
      "args": ["-y", "@pacifica-fi/mcp-server"],
      "env": {
        "ADDRESS": "<your Solana account address>",
        "AGENT_PRIVATE_KEY": "<your base58 agent wallet secret key>"
      }
    }
  }
}
```

## Other agents and harnesses

Every MCP client runs the server the same way — the command is `npx -y @pacifica-fi/mcp-server`
with the environment variables from the [table above](#environment-variables)
(`ADDRESS` plus `AGENT_PRIVATE_KEY` or `PRIVATE_KEY`; omit the key for read-only).
Only the config format differs per client. The examples below use agent-key mode;
swap in `PRIVATE_KEY`, or drop the key entirely for read-only.

### Claude Code

Add it with the CLI:

```bash
claude mcp add pacifica \
  --transport stdio \
  --env ADDRESS=<your account address> \
  --env AGENT_PRIVATE_KEY=<your agent wallet secret key> \
  -- npx -y @pacifica-fi/mcp-server
```

Or create `.mcp.json` in your project root (commit it to share with your team):

```json
{
  "mcpServers": {
    "pacifica": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@pacifica-fi/mcp-server"],
      "env": {
        "ADDRESS": "<your account address>",
        "AGENT_PRIVATE_KEY": "<your agent wallet secret key>"
      }
    }
  }
}
```

Verify with `claude mcp list`. Docs: <https://code.claude.com/docs/en/mcp>

### OpenAI Codex

Add it with the CLI:

```bash
codex mcp add pacifica \
  --env ADDRESS=<your account address> \
  --env AGENT_PRIVATE_KEY=<your agent wallet secret key> \
  -- npx -y @pacifica-fi/mcp-server
```

Or edit `~/.codex/config.toml` (note the nested `.env` table):

```toml
[mcp_servers.pacifica]
command = "npx"
args = ["-y", "@pacifica-fi/mcp-server"]

[mcp_servers.pacifica.env]
ADDRESS = "<your account address>"
AGENT_PRIVATE_KEY = "<your agent wallet secret key>"
```

Docs: <https://developers.openai.com/codex/mcp>

### Factory (droid)

Add it with the CLI:

```bash
droid mcp add pacifica "npx -y @pacifica-fi/mcp-server" \
  --env ADDRESS=<your account address> \
  --env AGENT_PRIVATE_KEY=<your agent wallet secret key>
```

Or edit `~/.factory/mcp.json` (user-level) or `.factory/mcp.json` (project-level):

```json
{
  "mcpServers": {
    "pacifica": {
      "command": "npx",
      "args": ["-y", "@pacifica-fi/mcp-server"],
      "env": {
        "ADDRESS": "<your account address>",
        "AGENT_PRIVATE_KEY": "<your agent wallet secret key>"
      }
    }
  }
}
```

Docs: <https://docs.factory.ai/cli/configuration/mcp>

### Hermes Agent

Edit `~/.hermes/config.yaml` (YAML, top-level `mcp_servers` key):

```yaml
mcp_servers:
  pacifica:
    command: "npx"
    args: ["-y", "@pacifica-fi/mcp-server"]
    env:
      ADDRESS: "<your account address>"
      AGENT_PRIVATE_KEY: "<your agent wallet secret key>"
```

Reload with `/reload-mcp` inside Hermes, or restart it.
Docs: <https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp>

### Crush

Edit `crush.json` in your project root (or `~/.config/crush/crush.json` for all projects).
The top-level key is `mcp` (not `mcpServers`), and Crush expands `$VAR` shell references
in values — so keep secrets in your environment rather than in the file:

```json
{
  "$schema": "https://charm.land/crush.json",
  "mcp": {
    "pacifica": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@pacifica-fi/mcp-server"],
      "env": {
        "ADDRESS": "$PACIFICA_ADDRESS",
        "AGENT_PRIVATE_KEY": "$PACIFICA_AGENT_PRIVATE_KEY"
      }
    }
  }
}
```

Docs: <https://github.com/charmbracelet/crush>

## Security

- **Never commit or paste your `PRIVATE_KEY` or `AGENT_PRIVATE_KEY` anywhere public.**
  Treat any key that has been exposed as compromised and rotate it.
- Prefer an **agent key** over your main key: it is revocable and limited in scope.
- The config file holds your key in plaintext — protect it like any other secret.

## Development

```bash
npm install        # install dependencies
npm run build      # type-check + emit dist/
npm run dev        # run the server from source (tsx watch)
npm test           # type-check only (tsc --noEmit)
npm run gen:keys   # generate 2 fresh keypairs (main + agent)
npm run smoke:3a   # live testnet smoke tests (read-only; signed suites need creds)
```

The `scripts/` directory contains live smoke tests against the Pacifica testnet
(`npm run smoke:1a`, `smoke:agent`, etc.). Tests that need credentials are skipped
unless `ADDRESS` / `PRIVATE_KEY` / `AGENT_PRIVATE_KEY` are set in the environment.

## License

[MIT](./LICENSE)

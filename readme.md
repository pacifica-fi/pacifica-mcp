# perp-exchange mcp api

Usage with Claude Desktop
Add the following to your claude_desktop_config.json:

## npx
```
{
  "mcpServers": {
    "pacifica": {
      "command": "npx",
      "args": [
        "-y",
        "@pacifica-fi/mcp-server"
      ],
      "env": {
        "PRIVATE_KEY": "2LyppieGiFKypm5X4usYbFHFznHmePvrFe9SqS1yasUwsozFwEUve3vcQET52jge3Ceu8wjf2q2fvDCCB9xQs1xc",
        "ADDRESS": "HEQ3kHCavWvgFtmBLNaFbDyBrVn9bU4CKctnRhxfrRVS"
      }
    }
  }
}
```
{
  description = "Pacifica MCP server - reproducible development environment";

  inputs = {
    nixpkgs.url = "nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # The published package targets node >=18 and CI runs on node 20; node 24
        # is a superset and matches the sibling repos' toolchain. Pinned via
        # flake.lock for reproducibility.
        nodejs = pkgs.nodejs_24;
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs                                      # node + npm + npx
            nodePackages.typescript-language-server     # editor LSP (builds use the project-local tsc)
            git
            jq                                          # handy for poking the REST API by hand
            curl
          ];

          shellHook = ''
            echo "pacifica-mcp dev environment  (node $(node --version), npm $(npm --version))"
            echo ""
            echo "  npm install        install dependencies"
            echo "  npm run build      type-check + emit dist/"
            echo "  npm run dev        run the server from source (tsx watch)"
            echo "  npm test           type-check only (tsc --noEmit)"
            echo "  npm run smoke:3a   live testnet smoke tests (read-only; signed suites need creds)"
            echo ""
            echo "  smoke-test creds: cp .envrc.local.example .envrc.local  (gitignored), then 'direnv allow'"
          '';
        };

        # Lets 'nix build' realise (and cache, e.g. in CI) the dev shell's inputs.
        packages.default = self.devShells.${system}.default.inputDerivation;
      }
    );
}

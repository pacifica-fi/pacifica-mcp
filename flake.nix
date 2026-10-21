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

        # Use the security release with its bundled libraries until nixpkgs catches up.
        # Checksums: https://nodejs.org/dist/v24.22.1/SHASUMS256.txt
        nodeArchive = {
          x86_64-linux = { platform = "linux-x64"; sha256 = "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6"; };
          aarch64-linux = { platform = "linux-arm64"; sha256 = "dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e"; };
          x86_64-darwin = { platform = "darwin-x64"; sha256 = "65e450f90a6eaacd5000f611861c4ce65fadc87f813795dc4ed0c0e5f2fca2d4"; };
          aarch64-darwin = { platform = "darwin-arm64"; sha256 = "654ba79de6155647e22321932b45f2a1ccb705976cc337c9b8e278beb085a628"; };
        }.${system};
        nodejs = pkgs.stdenv.mkDerivation rec {
          pname = "nodejs";
          version = "24.22.1";
          src = pkgs.fetchurl {
            url = "https://nodejs.org/dist/v${version}/node-v${version}-${nodeArchive.platform}.tar.xz";
            inherit (nodeArchive) sha256;
          };
          nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.autoPatchelfHook ];
          buildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.stdenv.cc.cc.lib ];
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp -r bin include lib share "$out/"
            runHook postInstall
          '';
        };
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

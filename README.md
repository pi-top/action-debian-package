# Build Debian package Github Action

*_NOTE: This action is in active development, and not recommended for use outside of the pi-top organisation until it has sufficiently matured._*

An action that builds a Debian package from source in a Docker container.
For more information about how to use the inputs to this action, see [action.yml](action.yml).

Note that this will build the package for the host machine's architecture (amd64) if no target architectures are specified.

## Usage

```yaml
- name: Build Debian package
  uses: pi-top/action-debian-package@v0.1.0
  with:
      source_directory: "./"
      artifacts_directory: "./"
      target_architecture: "amd64"
      dpkg_buildpackage_opts: "-us -uc -d"
      lintian_opts: ""

```

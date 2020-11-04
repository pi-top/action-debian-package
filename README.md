# Build Debian package Github Action

An action that builds a Debian package from source in a Docker container.
For more information about how to use the inputs to this action, see [action.yml](action.yml).

Note that this will build the package for the host machine's architecture (amd64) if no target architectures are specified.

## Usage

```yaml
- name: Build 32-bit and 64-bit ARM packages
  uses: pi-top/action-debian-package@v4
  with:
      source_directory: "./"
      artifacts_directory: "./"
      target_architectures: ""
      dpkg_buildpackage_opts: "-us -uc -d"
      lintian_opts: ""
      get_dev_packages_from_backports: "0"
```

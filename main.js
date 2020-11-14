const core = require("@actions/core")
const exec = require("@actions/exec")
const firstline = require("firstline")
const hub = require("docker-hub-utils")
const path = require("path")
const fs = require("fs")
const assert = require('assert')

function getReleaseDistribution(distribution) {
    return distribution.replace("UNRELEASED", "unstable")
}

async function getOS(distribution) {
    for (const os of ["debian", "ubuntu"]) {
        const tags = await hub.queryTags({ user: "library", name: os })
        if (tags.find(tag => tag.name == distribution)) {
            return os
        }
    }
}

async function main() {
    try {
        const hostArch = "amd64"

        /////////////////////////////////////////
        // Command line arguments - directories
        /////////////////////////////////////////
        const sourceRelativeDirectory = core.getInput("source_directory") || "./"
        const artifactsRelativeDirectory = core.getInput("artifacts_directory") || "./"

        /////////////////////////////////////////
        // Read changelog from source
        /////////////////////////////////////////
        const workspaceDirectory = process.cwd()
        const sourceDirectory = path.join(workspaceDirectory, sourceRelativeDirectory)
        const buildDirectory = path.dirname(sourceDirectory)
        const artifactsDirectory = path.join(workspaceDirectory, artifactsRelativeDirectory)

        const file = path.join(sourceDirectory, "debian/changelog")
        const changelog = await firstline(file)
        const regex = /^(?<sourcePackage>.+) \(((?<epoch>[0-9]+):)?(?<upstreamVersion>[^:-]+)(-(?<debianRevision>[^:-]+))?\) (?<sourceDistribution>.+);/
        const match = changelog.match(regex)
        const { sourcePackage, epoch, upstreamVersion, debianRevision, sourceDistribution } = match.groups
        const container = sourcePackage

        //////////////////////////////////////
        // Command line arguments - other
        //////////////////////////////////////
        const targetArchitecture = core.getInput("target_architecture") || hostArch

        assert(
            (targetArchitecture == hostArch) ||
            (targetArchitecture == "armhf") ||
            (targetArchitecture == "arm64")
        )

        // Don't sign anything - no keys provided
        // Don't worry about build dependencies - we have already installed them
        // (Seems to not recognize that some packages are installed)
        const _defaultDpkgBuildPackageOpts = "-us -uc -d"
        const dpkgBuildPackageOpts = core.getInput("dpkg_buildpackage_opts") || _defaultDpkgBuildPackageOpts
        const lintianOpts = core.getInput("lintian_opts") || ""
        const buildDistribution = core.getInput("distribution") || getReleaseDistribution(sourceDistribution)
        const imageOS = await getOS(buildDistribution)

        imageArchPrefix = ""
        if (targetArchitecture == "armhf") {
            imageArchPrefix = "arm32v7/"
        } else if (targetArchitecture == "arm64") {
            imageArchPrefix = "arm64v8/"
        }

        const image = imageArchPrefix + imageOS + ":" + buildDistribution

        fs.mkdirSync(artifactsDirectory, { recursive: true })

        //////////////////////////////////////
        // Print details
        //////////////////////////////////////
        core.startGroup("Host: Print details")
        const details = {
            sourcePackage: sourcePackage,
            epoch: epoch,
            upstreamVersion: upstreamVersion,
            debianRevision: debianRevision,
            sourceDistribution: sourceDistribution,
            imageOS: imageOS,
            container: container,
            image: image,
            workspaceDirectory: workspaceDirectory,
            sourceDirectory: sourceDirectory,
            buildDirectory: buildDirectory,
            artifactsDirectory: artifactsDirectory
        }
        console.log(details)
        core.endGroup()

        function getDockerCreateArgsForArch(arch) {
            if (arch == hostArch) {
                args = []
            } else {
                args = [
                    "--volume",
                    "/usr/bin/qemu-"+arch+"-static:/usr/bin/qemu-"+arch+"-static"
                ]
            }

            return args.concat([
                "--volume", workspaceDirectory + ":" + workspaceDirectory,
                "--workdir", sourceDirectory,
                "--env", "DH_VERBOSE=1",
                "--env", "DEBIAN_FRONTEND=noninteractive",
                "--env", "DPKG_COLORS=always",
                "--env", "FORCE_UNSAFE_CONFIGURE=1",
                "--tty",
                image,
                "sleep", "inf"
            ])
        }

        //////////////////////////////////////
        // Install emulation dependencies
        //////////////////////////////////////
        if (targetArchitecture != hostArch) {
            core.startGroup("Host: Update packages list")
            await exec.exec("sudo", ["apt-get", "update"])
            core.endGroup()

            core.startGroup("Host: Install emulation requirements")
            await exec.exec("sudo", [
                "apt-get",
                "install",
                "-y",
                // Emulating other architectures
                "qemu-user",
                "qemu-user-static",
                "binfmt-support"
            ])
            core.endGroup()

            if (targetArchitecture == "armhf") {
                qemuArch = "arm"
            } else {
                qemuArch = "aarch64"
            }
        }

        //////////////////////////////////////
        // Create and start container
        //////////////////////////////////////
        core.startGroup("Host: Create container")
        await exec.exec("docker", [
                "create",
                "--name", container,
                ].concat(getDockerCreateArgsForArch(qemuArch))
        )
        core.endGroup()

        core.startGroup("Host: Start container")
        await exec.exec("docker", [
            "start",
            container
        ])
        core.endGroup()

        //////////////////////////////////////
        // Create tarball of source if package is Debian revision of upstream
        //////////////////////////////////////
        if (debianRevision) {
            core.startGroup("Container: Create tarball")
            await exec.exec("docker", ["exec", container].concat(
                [
                    "tar",
                    "--exclude-vcs",
                    "--exclude", "./debian",
                    "-cvzf", `${buildDirectory}/${sourcePackage}_${upstreamVersion}.orig.tar.gz`,
                    "-C", sourceDirectory,
                    "./"
                ]
            ))
            core.endGroup()
        }

        //////////////////////////////////////
        // Update packages list
        //////////////////////////////////////
        core.startGroup("Container: Update packages list")
        await exec.exec("docker", ["exec", container].concat(
            ["apt-get", "update"]
        ))
        core.endGroup()

        //////////////////////////////////////
        // Install required packages
        //////////////////////////////////////
        core.startGroup("Container: Install development packages")
        await exec.exec("docker", ["exec", container].concat(
            [
                "apt-get", "install",
                "-t", buildDistribution,
                "--no-install-recommends",
                "-y",
                // General packaging stuff
                "dpkg-dev",
                "debhelper",
                "lintian"
            ]
        ))
        core.endGroup()

        core.startGroup("Container: Install build dependencies")
        await exec.exec("docker", ["exec", container].concat(
            [
                "apt-get", "build-dep",
                "-y",
                sourceDirectory,
            ]
        ))
        core.endGroup()

        //////////////////////////////////////
        // Build package and run static analysis
        //////////////////////////////////////
        core.startGroup("Container: Build package")
        await exec.exec("docker", ["exec", container].concat(
            ["dpkg-buildpackage"].concat(dpkgBuildPackageOpts.split(" "))
        ))
        core.endGroup()

        core.startGroup("Container: Run static analysis")
        await exec.exec("docker", ["exec", container].concat(
            [
                "find",
                buildDirectory,
                "-maxdepth", "1",
                "-name", `*${targetArchitecture}.changes`,
                "-type", "f",
                "-print",
                "-exec",
                "lintian"
            ]).concat(lintianOpts.split(" ")).concat(["{}", "+"]
        ))
        core.endGroup()

        //////////////////////////////////////
        // Move artifacts
        //////////////////////////////////////
        core.startGroup("Container: Move artifacts")
        await exec.exec("docker", ["exec", container].concat(
            [
                "find",
                buildDirectory,
                "-maxdepth", "1",
                "-name", `*${upstreamVersion}*.*`,
                "-type", "f",
                "-print",
                "-exec", "mv", "{}", artifactsDirectory, ";"
            ]
        ))
        core.endGroup()
    } catch (error) {
        core.setFailed(error.message)
    }
}

main()

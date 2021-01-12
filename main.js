const core = require("@actions/core")
const exec = require("@actions/exec")
const firstline = require("firstline")
const hub = require("docker-hub-utils")
const path = require("path")
const fs = require("fs")
const assert = require('assert')

function getPlatformForArchitecture(architecture) {
    assert(
        (architecture == "amd64") ||
        (architecture == "arm64") ||
        (architecture == "armhf") ||
        (architecture == "i386") ||
        (architecture == "mips64el") ||
        (architecture == "ppc64el") ||
        (architecture == "s390x")
    )

    if (architecture == "amd64") {
        return "linux/amd64"
    } else if (architecture == "arm64") {
        return "linux/arm64/v8"
    } else if (architecture == "armhf") {
        return "linux/arm/v7"
    } else if (architecture == "i386") {
        return "linux/386"
    } else if (architecture == "mips64el") {
        return "linux/mips64le"
    } else if (architecture == "ppc64el") {
        return "linux/ppc64le"
    } else if (architecture == "s390x") {
        return "linux/s390x"
    }
}

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
        const hostArchitecture = "amd64"
        const hostPlatform = getPlatformForArchitecture(hostArchitecture)

        //////////////////////////////////////
        // Command line arguments - architecture
        //////////////////////////////////////
        const targetArchitecture = core.getInput("target_architecture") || hostArchitecture
        const targetPlatform = getPlatformForArchitecture(targetArchitecture)
        const emulatedArchitecture = (targetArchitecture != hostArchitecture)

        /////////////////////////////////////////
        // Command line arguments - directories
        /////////////////////////////////////////
        const workspaceDirectory = process.cwd()
        const sourceDirectory = core.getInput("source_directory") || workspaceDirectory
        const artifactsDirectory = core.getInput("artifacts_directory") || workspaceDirectory
        const buildDirectory = path.dirname(sourceDirectory)

        /////////////////////////////////////////
        // Read changelog from source
        /////////////////////////////////////////
        const file = path.join(sourceDirectory, "debian/changelog")
        const changelog = await firstline(file)
        const regex = /^(?<sourcePackage>.+) \(((?<epoch>[0-9]+):)?(?<upstreamVersion>[^:-]+)(-(?<debianRevision>[^:-]+))?\) (?<sourceDistribution>.+);/
        const match = changelog.match(regex)
        const { sourcePackage, epoch, upstreamVersion, debianRevision, sourceDistribution } = match.groups
        const container = sourcePackage

        //////////////////////////////////////
        // Command line arguments - other
        //////////////////////////////////////
        // Don't sign anything - no keys provided
        // Don't worry about build dependencies - we have already installed them
        // (Seems to not recognize that some packages are installed)
        const _defaultDpkgBuildPackageOpts = "-us -uc -d"
        const dpkgBuildPackageOpts = core.getInput("dpkg_buildpackage_opts") || _defaultDpkgBuildPackageOpts
        const lintianOpts = core.getInput("lintian_opts") || ""

        const buildDistribution = core.getInput("distribution") || getReleaseDistribution(sourceDistribution)

        const imageOS = await getOS(buildDistribution)
        const dockerImage = core.getInput("docker_image") || imageOS + ":" + buildDistribution

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
            container: container,
            dockerImage: dockerImage,
            targetPlatform: targetPlatform,
            workspaceDirectory: workspaceDirectory,
            sourceDirectory: sourceDirectory,
            buildDirectory: buildDirectory,
            artifactsDirectory: artifactsDirectory
        }
        console.log(details)
        core.endGroup()

        //////////////////////////////////////
        // Configure for emulation
        //     Start arch emulation container
        //     Enable experimental Docker features
        //////////////////////////////////////
        if (emulatedArchitecture) {
            core.startGroup("Host: Start architecture emulation")
            await exec.exec("docker", [
                    "run",
                    "--privileged", "--rm",
                    "docker/binfmt:a7996909642ee92942dcd6cff44b9b95f08dad64",
                ]
            )
            core.endGroup()

            core.startGroup("Host: Enable experimental Docker features")
            dockerDaemonFile = "/etc/docker/daemon.json"
            // Allow writing to file without being sudo
            await exec.exec("sudo", ["chmod", "o+w", dockerDaemonFile])
            const dockerDaemonData = JSON.parse(fs.readFileSync(dockerDaemonFile))
            dockerDaemonData.experimental = true
            fs.writeFileSync(
                dockerDaemonFile,
                JSON.stringify(dockerDaemonData)
            )
            await exec.exec("sudo", ["service", "docker", "restart"])
            core.endGroup()
        }

        //////////////////////////////////////
        // Create and start container
        //////////////////////////////////////
        function getDockerCreateArgsForPlatform(targetPlatform) {
            args = []
            if (emulatedArchitecture) {
                args = ["--platform=" + targetPlatform]
            }

            return args.concat([
                "--volume", workspaceDirectory + ":" + workspaceDirectory,
                "--workdir", sourceDirectory,
                "--env", "DH_VERBOSE=1",
                "--env", "DEBIAN_FRONTEND=noninteractive",
                "--env", "DPKG_COLORS=always",
                "--env", "FORCE_UNSAFE_CONFIGURE=1",
                "--tty",
                dockerImage,
                "sleep", "inf"  // Make container run forever
            ])
        }
        core.startGroup("Host: Create container")
        await exec.exec("docker", [
                "create",
                "--name", container
            ].concat(getDockerCreateArgsForPlatform(targetPlatform))
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

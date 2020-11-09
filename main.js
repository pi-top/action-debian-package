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
        const regex = /^(?<sourcePackage>.+) \(((?<epoch>[0-9]+):)?(?<version>[^:-]+)(-(?<revision>[^:-]+))?\) (?<sourceDistribution>.+);/
        const match = changelog.match(regex)
        const { sourcePackage, epoch, version, revision, sourceDistribution } = match.groups
        const container = sourcePackage

        //////////////////////////////////////
        // Command line arguments - other
        //////////////////////////////////////
        const targetArchitectures = core.getInput("target_architectures").replace(" ", "").split(",") || ["amd64"]
        assert(targetArchitectures.length > 0)

        const additionalPackagesArchDep = core.getInput("additional_target_arch_multiarch_packages").replace(" ", "").split(",") || []


        // Don't sign anything - no keys provided
        // Don't worry about build dependencies - we have already installed them
        // (Seems to not recognize that some packages are installed)
        const _defaultDpkgBuildPackageOpts = "-us -uc -d --post-clean"
        const dpkgBuildPackageOpts = core.getInput("dpkg_buildpackage_opts") || _defaultDpkgBuildPackageOpts
        const lintianOpts = core.getInput("lintian_opts") || ""
        const buildDistribution = core.getInput("distribution") || getReleaseDistribution(sourceDistribution)
        const imageOS = await getOS(buildDistribution)
        const image = imageOS + ":" + buildDistribution

        fs.mkdirSync(artifactsDirectory, { recursive: true })

        //////////////////////////////////////
        // Print details
        //////////////////////////////////////
        core.startGroup("Print details")
        const details = {
            sourcePackage: sourcePackage,
            epoch: epoch,
            version: version,
            revision: revision,
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

        //////////////////////////////////////
        // Create and start container
        //////////////////////////////////////
        core.startGroup("Create container")
        await exec.exec("docker", [
            "create",
            "--name", container,
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
        core.endGroup()

        core.startGroup("Start container")
        await exec.exec("docker", [
            "start",
            container
        ])
        core.endGroup()

        //////////////////////////////////////
        // Create tarball of source if package is revision of upstream
        //////////////////////////////////////
        if (revision) {
            core.startGroup("Create tarball")
            await exec.exec("docker", ["exec", container].concat(
                [
                    "tar",
                    "--exclude-vcs",
                    "--exclude", "./debian",
                    "--transform", `s/^\./${sourcePackage}-${version}/`,
                    "-cvzf", `${buildDirectory}/${sourcePackage}_${version}.orig.tar.gz`,
                    "-C", sourceDirectory,
                    "./"
                ]
            ))
            core.endGroup()
        }

        //////////////////////////////////////
        // Add target architectures
        //////////////////////////////////////
        for (const targetArchitecture of targetArchitectures) {
            if (targetArchitecture != "amd64") {
                core.startGroup("Add target architecture: " + targetArchitecture)
                await exec.exec("docker", ["exec", container].concat(
                    ["dpkg", "--add-architecture", targetArchitecture]
                ))
                core.endGroup()
            }
        }

        //////////////////////////////////////
        // Update packages list
        //////////////////////////////////////
        core.startGroup("Update packages list")
        await exec.exec("docker", ["exec", container].concat(
            ["apt-get", "update"]
        ))
        core.endGroup()

        //////////////////////////////////////
        // Install required packages
        //////////////////////////////////////
        function getDevPackages() {
            devPackages = [
                // General packaging stuff
                "dpkg-dev",
                "debhelper",
                "lintian"
            ]

            // Add additional target architecture-specific packages
            const additionalPackagesToInstall = targetArchitectures.reduce(
                (accumulator, targetArchitecture) => [
                    ...accumulator,
                    ...additionalPackagesArchDep.map(package => `${package}:${targetArchitecture}`)
                ],
                []
            )

            return devPackages.concat(additionalPackagesToInstall)
        }

        core.startGroup("Install development packages")
        await exec.exec("docker", ["exec", container].concat(
            [
                "apt-get", "install",
                "-t", buildDistribution,
                "--no-install-recommends",
                "-y"
            ].concat(getDevPackages())
        ))
        core.endGroup()

        core.startGroup("Install build dependencies")
        await exec.exec("docker", ["exec", container].concat(
            [
                "apt-get", "build-dep",
                "-y",
                sourceDirectory,
            ]
        ))
        core.endGroup()

        //////////////////////////////////////
        // Build package and run static analysis for all architectures
        //////////////////////////////////////
        for (const targetArchitecture of targetArchitectures) {
            core.startGroup("Build package for architecture: " + targetArchitecture)
            await exec.exec("docker", ["exec", container].concat(
                [
                    "dpkg-buildpackage",
                    "-a", targetArchitecture,
                    // "--host-arch", targetArchitecture,
                    // "--target-arch", targetArchitecture,
                ].concat(dpkgBuildPackageOpts.split(" "))
            ))
            core.endGroup()

            core.startGroup("Run static analysis for architecture: " + targetArchitecture)
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
        }

        //////////////////////////////////////
        // Move artifacts
        //////////////////////////////////////
        core.startGroup("Move artifacts")
        await exec.exec("docker", ["exec", container].concat(
            [
                "find",
                buildDirectory,
                "-maxdepth", "1",
                "-name", `*${version}*.*`,
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

// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "AgentForgeCore",
    platforms: [
        .iOS(.v26),
        .macOS(.v15)
    ],
    products: [
        .library(
            name: "AgentForgeCore",
            targets: ["AgentForgeCore"]
        )
    ],
    targets: [
        .target(name: "AgentForgeCore"),
        .testTarget(
            name: "AgentForgeCoreTests",
            dependencies: ["AgentForgeCore"]
        )
    ]
)

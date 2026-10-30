pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // sherpa-onnx（端侧 KWS）未发布到 Maven Central，仅提供 JitPack 坐标
        maven { url = uri("https://jitpack.io") }
    }
}

rootProject.name = "Kinship"
include(":app")

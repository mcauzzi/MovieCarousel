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
    }
}

rootProject.name = "CineManager"

// core: logica pura Kotlin/JVM (firma, QR, client API, modulo), testata con JUnit sulla JVM.
// app: interfaccia Android (Compose, CameraX + ML Kit, Keystore, DataStore).
include(":core", ":app")

import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// Versione da android/version.properties (docs/scanner-dvd.md §11.1):
// versionCode = major*10000 + minor*100 + patch.
val versionProps = Properties().apply {
    rootProject.file("version.properties").inputStream().use(::load)
}
val appVersionName: String = versionProps.getProperty("versionName")
val appVersionCode: Int = appVersionName.split(".").map(String::toInt).let { (major, minor, patch) ->
    require(minor in 0..99 && patch in 0..99) { "versionName non valido: $appVersionName" }
    major * 10000 + minor * 100 + patch
}
val appMinSupportedCode: Int = versionProps.getProperty("minSupportedCode").trim().toInt().also {
    require(it <= appVersionCode) { "minSupportedCode ($it) maggiore del versionCode ($appVersionCode)" }
}

// Valori letti dal job android di deploy.yml per version.json: una sola formula del versionCode.
tasks.register("printVersion") {
    description = "Stampa versionName, versionCode e minSupportedCode (righe chiave=valore)."
    val name = appVersionName
    val code = appVersionCode
    val min = appMinSupportedCode
    doLast {
        println("versionName=$name")
        println("versionCode=$code")
        println("minSupportedCode=$min")
    }
}

// Firma di release solo da variabili d'ambiente (in CI dai GitHub Secrets, vedi android/README.md).
// Senza, assembleRelease produce un APK non firmato.
val releaseKeystore = providers.environmentVariable("CM_RELEASE_KEYSTORE").orNull
val releaseSigning = releaseKeystore?.takeIf { it.isNotBlank() && file(it).isFile }

android {
    namespace = "io.github.mcauzzi.cinemanager"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.mcauzzi.cinemanager"
        minSdk = 30 // setUserAuthenticationParameters (§4.2)
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName
        resValue("string", "app_name", "CineManager")
    }

    signingConfigs {
        if (releaseSigning != null) {
            create("release") {
                storeFile = file(releaseSigning)
                storePassword = providers.environmentVariable("CM_RELEASE_KEYSTORE_PASSWORD").get()
                keyAlias = providers.environmentVariable("CM_RELEASE_KEY_ALIAS").get()
                keyPassword = providers.environmentVariable("CM_RELEASE_KEY_PASSWORD").get()
                enableV1Signing = false // minSdk 30: bastano v2/v3
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            // Si installa accanto alla release (firme diverse), §11.1.
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            resValue("string", "app_name", "CineManager (debug)")
            buildConfigField("boolean", "ALLOW_HTTP", "true")
        }
        release {
            // R8: l'APK passa da ~60 MB (debug) a ~15 MB. Le librerie (OkHttp, kotlinx.serialization,
            // CameraX, ML Kit) portano le proprie regole; le nostre sono in proguard-rules.pro.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Solo ARM: i telefoni reali (le librerie native di ML Kit x86 servono solo agli emulatori).
            ndk { abiFilters += setOf("arm64-v8a", "armeabi-v7a") }
            buildConfigField("boolean", "ALLOW_HTTP", "false")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += setOf("META-INF/{AL2.0,LGPL2.1}", "META-INF/versions/9/OSGI-INF/MANIFEST.MF")
    }

    lint {
        abortOnError = true
        checkDependencies = true // analizza anche :core
        // Controlli che richiedono la rete o segnalano solo versioni più nuove.
        // ChromeOsAbiSupport: la release include solo ARM (vedi buildTypes.release).
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion", "OldTargetApi", "ChromeOsAbiSupport")
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation(project(":core"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.fragment.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)

    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.androidx.camera.mlkit.vision)
    implementation(libs.mlkit.barcode.scanning) // modello incluso nell'APK: funziona offline

    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.biometric)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)

    testImplementation(libs.junit)
}

// `testDebugUnitTest` esegue anche i test JVM di :core (firma, QR, client API, modulo).
tasks.matching { it.name == "testDebugUnitTest" || it.name == "testReleaseUnitTest" }.configureEach {
    dependsOn(":core:test")
}

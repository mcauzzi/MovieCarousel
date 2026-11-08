import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Logica senza dipendenze Android: firma delle richieste e prova di possesso, QR di abbinamento,
// client dell'API e mappatura degli errori, modulo dai campi della collezione. Test JUnit sulla JVM.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.android.lint)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

lint {
    // Controlli che richiedono la rete o segnalano solo versioni più nuove; TrulyRandom riguarda Android ≤ 4.3.
    disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion", "TrulyRandom")
}

dependencies {
    api(libs.okhttp)
    api(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.core)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
}

tasks.test {
    testLogging { events("failed", "skipped"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}

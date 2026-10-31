package io.github.mcauzzi.cinemanager.ui

import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import io.github.mcauzzi.cinemanager.core.api.AppVersionInfo
import io.github.mcauzzi.cinemanager.core.api.Candidate
import io.github.mcauzzi.cinemanager.core.api.DuplicateRef
import io.github.mcauzzi.cinemanager.core.api.LookupResponse
import io.github.mcauzzi.cinemanager.core.api.NewMovieRequest
import io.github.mcauzzi.cinemanager.core.form.FieldValue
import io.github.mcauzzi.cinemanager.core.form.FormField
import kotlinx.serialization.json.JsonObject

/** Testo da mostrare: risorsa con argomenti o testo del server. */
sealed interface UiText {
    data class Res(@param:StringRes val id: Int, val args: List<Any> = emptyList()) : UiText
    data class Raw(val text: String) : UiText
    data class Plural(@param:PluralsRes val id: Int, val count: Int) : UiText
}

fun text(@StringRes id: Int, vararg args: Any): UiText = UiText.Res(id, args.toList())

data class UiState(
    val screen: Screen = Screen.Loading,
    val busy: Boolean = false,
    /** Messaggio temporaneo (snackbar). */
    val message: UiText? = null,
    /** Il messaggio ha il pulsante "Riprova" (errore passeggero). */
    val messageRetryable: Boolean = false,
    /** Aggiornamento disponibile, non bloccante (banner). */
    val update: AppVersionInfo? = null,
    /** Sblocco richiesto: l'Activity mostra il prompt biometrico e riporta l'esito. */
    val authPending: Boolean = false,
    /** "Chiedi impronta all'apertura": app bloccata finché non si conferma. */
    val locked: Boolean = false,
    /** Non null = impostazioni aperte. */
    val settings: SettingsInfo? = null,
)

data class SettingsInfo(
    val server: String,
    val siteUrl: String,
    val userName: String,
    val deviceName: String,
    val requireBiometric: Boolean,
    val biometricAvailable: Boolean,
    val appVersion: String,
)

sealed interface Screen {
    data object Loading : Screen

    /** 1. Abbinamento: scansione del QR del sito (o incolla il contenuto). */
    data class Pairing(
        val deviceName: String,
        val scanning: Boolean = false,
        val manual: String = "",
        val error: UiText? = null,
        /** "Chiedi impronta all'apertura" per la chiave che verrà creata. */
        val requireBiometric: Boolean = false,
        val biometricAvailable: Boolean = false,
    ) : Screen

    /**
     * Abbinamento da rifare (dispositivo revocato, chiave invalidata). [serverStillActive]: sul
     * server il dispositivo non è stato revocato, va fatto dal sito.
     */
    data class Repair(val reason: UiText, val serverStillActive: Boolean = false) : Screen

    /** Versione sotto `minSupportedCode` (version.json o 426): invio disabilitato. */
    data class UpdateRequired(val apkUrl: String?, val minSupportedCode: Int?) : Screen

    /** Il proprietario deve aprire il sito (403 owner_inactive). */
    data class OwnerInactive(val siteUrl: String?) : Screen

    /** 2. Scansione dell'EAN (o inserimento a mano). */
    data class Scan(val manualEan: String = "") : Screen

    /** 3. Scelta tra i candidati TMDb, o ricerca a mano. */
    data class Choose(
        val ean: String,
        val lookup: LookupResponse,
        val candidates: List<Candidate>,
        val query: String,
        val year: String = "",
        val searched: Boolean = false,
    ) : Screen

    /** 4. Modulo modificabile prima dell'invio. */
    data class Form(
        val source: DraftSource,
        val fields: List<FormField>,
        val values: Map<String, FieldValue>,
        val passthrough: JsonObject,
        val errors: Map<String, String> = emptyMap(),
        val generalError: UiText? = null,
    ) : Screen

    /** 5. Esito dell'invio. */
    data class Result(val outcome: Outcome) : Screen
}

/** Da dove viene la bozza del modulo. */
data class DraftSource(
    val ean: String,
    val tmdbId: Int?,
    val posterPath: String?,
    val posterUrl: String?,
    val duplicates: List<DuplicateRef>,
    /** Per tornare alla scelta dei candidati. */
    val choose: Screen.Choose?,
)

sealed interface Outcome {
    data class Added(val id: Long, val title: String) : Outcome
    data class EanExists(val title: String?) : Outcome
    data class PossibleDuplicate(val candidates: List<DuplicateRef>, val request: NewMovieRequest, val form: Screen.Form) : Outcome
}

package io.github.mcauzzi.cinemanager.core.pairing

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Contenuto del QR di abbinamento: `{"v":1,"api":"https://<host-sito>/api","code":"<code>"}`. */
data class PairingQr(val server: ServerUrls, val code: String)

sealed interface PairingQrResult {
    data class Valid(val qr: PairingQr) : PairingQrResult
    data class Invalid(val reason: Reason) : PairingQrResult

    enum class Reason {
        /** Non è il QR di CineManager (non JSON o campi mancanti). */
        NOT_CINEMANAGER,

        /** Versione del QR diversa da 1: serve un'app più recente. */
        UNSUPPORTED_VERSION,

        /** Indirizzo dell'API non valido. */
        BAD_API,

        /** Indirizzo `http://` in una build di release. */
        INSECURE_API,

        /** Codice di abbinamento malformato. */
        BAD_CODE,
    }
}

object PairingQrParser {
    const val SUPPORTED_VERSION = 1
    private const val MAX_CODE = 64
    private val json = Json { ignoreUnknownKeys = true }

    /** @param allowHttp `true` solo nelle build di debug (API locale, es. `http://10.0.2.2:5080/api`). */
    fun parse(text: String, allowHttp: Boolean): PairingQrResult {
        val obj = try {
            json.parseToJsonElement(text.trim()) as? JsonObject
        } catch (_: IllegalArgumentException) {
            null
        } ?: return invalid(PairingQrResult.Reason.NOT_CINEMANAGER)

        val api = obj.string("api")
        val code = obj.string("code")
        val v = (obj["v"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
        if (api == null || code == null || v == null) return invalid(PairingQrResult.Reason.NOT_CINEMANAGER)
        if (v != SUPPORTED_VERSION) return invalid(PairingQrResult.Reason.UNSUPPORTED_VERSION)

        val server = when (val r = ServerUrls.parse(api, allowHttp)) {
            is ServerUrls.ParseResult.Ok -> r.urls
            ServerUrls.ParseResult.Insecure -> return invalid(PairingQrResult.Reason.INSECURE_API)
            ServerUrls.ParseResult.Invalid -> return invalid(PairingQrResult.Reason.BAD_API)
        }
        if (code.length !in 1..MAX_CODE ||
            code.any { !(it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_') }
        ) return invalid(PairingQrResult.Reason.BAD_CODE)
        return PairingQrResult.Valid(PairingQr(server, code))
    }

    private fun invalid(reason: PairingQrResult.Reason) = PairingQrResult.Invalid(reason)

    private fun JsonObject.string(name: String): String? =
        (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.content

}

/**
 * Indirizzi derivati da quello dell'API salvato all'abbinamento (`https://<host-sito>/api`).
 * La radice del sito è l'API senza il suffisso `/api`.
 */
class ServerUrls private constructor(val apiBase: String) {
    /** Radice del sito, senza `/` finale. */
    val siteRoot: String = apiBase.removeSuffix("/api")

    /** `version.json` servito da nginx sotto `/api/app/` (senza forward auth, §11.1). */
    val versionUrl: String get() = "$apiBase/app/version"

    /** APK nel sito (passa dal login del sito: si apre nel browser). */
    val apkUrl: String get() = "$siteRoot/app/cinemanager.apk"

    val host: String get() = apiBase.toHttpUrlOrNull()?.host ?: apiBase

    override fun equals(other: Any?) = other is ServerUrls && other.apiBase == apiBase
    override fun hashCode() = apiBase.hashCode()
    override fun toString() = apiBase

    sealed interface ParseResult {
        data class Ok(val urls: ServerUrls) : ParseResult
        data object Insecure : ParseResult
        data object Invalid : ParseResult
    }

    companion object {
        fun parse(api: String, allowHttp: Boolean): ParseResult {
            val url = api.trim().toHttpUrlOrNull() ?: return ParseResult.Invalid
            if (url.username.isNotEmpty() || url.password.isNotEmpty() || url.query != null || url.fragment != null)
                return ParseResult.Invalid
            if (!url.isHttps && !allowHttp) return ParseResult.Insecure
            // Forma canonica: schema e host minuscoli, porta solo se non standard, niente "/" finale.
            val base = url.toString().trimEnd('/')
            return ParseResult.Ok(ServerUrls(base))
        }

        /** Per valori già validati (salvati dopo l'abbinamento). */
        fun trusted(apiBase: String): ServerUrls = ServerUrls(apiBase.trimEnd('/'))
    }
}

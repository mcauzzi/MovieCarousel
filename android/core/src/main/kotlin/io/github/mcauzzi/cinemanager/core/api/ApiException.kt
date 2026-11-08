package io.github.mcauzzi.cinemanager.core.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/** Errori dell'API già classificati per l'interfaccia (docs/api.md, "Esiti"). */
sealed class ApiException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    /** Rete assente, timeout, TLS. */
    class Network(cause: Throwable) : ApiException("Errore di rete: ${cause.message}", cause)

    /** 401 `device_revoked` (anche dispositivo sconosciuto): torna all'abbinamento. */
    class DeviceRevoked : ApiException("Dispositivo revocato")

    /**
     * Altri 401: il problema è nella richiesta (`expired` di solito è l'orologio del telefono,
     * `replay` una richiesta ripetuta). Non si rifà l'abbinamento.
     */
    class Unauthorized(val reason: String?) : ApiException("Richiesta firmata rifiutata: $reason")

    /** 403 `owner_inactive`: il proprietario deve aprire il sito una volta. */
    class OwnerInactive : ApiException("Proprietario non autorizzato")

    /** Altri 403. */
    class Forbidden(val detail: String?) : ApiException("Accesso negato")

    /** 426 `upgrade_required`. */
    class UpgradeRequired(val minSupportedCode: Int?) : ApiException("Aggiornamento necessario")

    /** 400 con `errors` per campo (validazione del film) o `detail`. */
    class Validation(val errors: Map<String, List<String>>, val detail: String?) :
        ApiException("Dati non validi: ${detail ?: errors}")

    /** 400 di `POST /api/app/pair` con `reason`. */
    class PairingFailed(val reason: PairFailure, val detail: String?) : ApiException("Abbinamento non riuscito: $reason")

    class NotFound : ApiException("Non trovato")

    /** 429 con `Retry-After` (secondi), se presente. */
    class RateLimited(val retryAfterSeconds: Long?) : ApiException("Troppe richieste")

    /** 413 `body_too_large`. */
    class TooLarge : ApiException("Richiesta troppo grande")

    /** 502/503 di `search`/`tmdb`: TMDb non configurato o non raggiungibile. */
    class TmdbUnavailable(val notConfigured: Boolean) : ApiException("TMDb non disponibile")

    /** Altre risposte inattese (5xx, corpo non valido...). */
    class Server(val status: Int, val detail: String?) : ApiException("Errore del server ($status)")
}

enum class PairFailure { INVALID_REQUEST, INVALID_KEY, INVALID_PROOF, INVALID_CODE, UNKNOWN }

/** Traduzione di una risposta non riuscita in [ApiException]. */
object ErrorMapper {
    private val json = Json { ignoreUnknownKeys = true }

    data class Problem(
        val title: String?,
        val detail: String?,
        val reason: String?,
        val minSupportedCode: Int?,
        val errors: Map<String, List<String>>,
    )

    fun parseProblem(body: String?): Problem {
        val obj = try {
            body?.takeIf { it.isNotBlank() }?.let { json.parseToJsonElement(it) as? JsonObject }
        } catch (_: IllegalArgumentException) {
            null
        }
        fun str(name: String) = (obj?.get(name) as? JsonPrimitive)?.takeIf { it.isString }?.content
        val errors = (obj?.get("errors") as? JsonObject)?.mapValues { (_, v) ->
            when (v) {
                is JsonArray -> v.mapNotNull { (it as? JsonPrimitive)?.content }
                is JsonPrimitive -> listOf(v.content)
                else -> emptyList()
            }
        } ?: emptyMap()
        return Problem(
            title = str("title"),
            detail = str("detail"),
            reason = str("reason"),
            minSupportedCode = (obj?.get("minSupportedCode") as? JsonPrimitive)?.intOrNull,
            errors = errors,
        )
    }

    /**
     * @param pairing `true` per `POST /api/app/pair` (i 400 hanno un `reason` di abbinamento).
     * @param tmdb `true` per `search`/`tmdb`, dove 502/503 significano TMDb non disponibile.
     */
    fun map(status: Int, body: String?, retryAfter: String? = null, pairing: Boolean = false, tmdb: Boolean = false): ApiException {
        val p = parseProblem(body)
        return when (status) {
            400 -> if (pairing) {
                // `reason` = nome del valore in minuscolo (invalid_code...); altri valori → UNKNOWN.
                val reason = PairFailure.entries.firstOrNull { it.name.lowercase() == p.reason }
                ApiException.PairingFailed(reason ?: PairFailure.UNKNOWN, p.detail)
            } else {
                ApiException.Validation(p.errors, p.detail)
            }
            401 -> if (p.reason == "device_revoked") ApiException.DeviceRevoked() else ApiException.Unauthorized(p.reason)
            403 -> if (p.reason == "owner_inactive") ApiException.OwnerInactive() else ApiException.Forbidden(p.detail)
            404 -> ApiException.NotFound()
            413 -> ApiException.TooLarge()
            426 -> ApiException.UpgradeRequired(p.minSupportedCode)
            429 -> ApiException.RateLimited(retryAfter?.trim()?.toLongOrNull())
            502, 503 -> if (tmdb) ApiException.TmdbUnavailable(notConfigured = status == 503) else ApiException.Server(status, p.detail)
            else -> ApiException.Server(status, p.detail ?: p.title)
        }
    }
}

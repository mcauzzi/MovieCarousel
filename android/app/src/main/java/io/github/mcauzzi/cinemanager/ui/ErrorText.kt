package io.github.mcauzzi.cinemanager.ui

import io.github.mcauzzi.cinemanager.R
import io.github.mcauzzi.cinemanager.core.api.ApiException
import io.github.mcauzzi.cinemanager.core.api.PairFailure
import io.github.mcauzzi.cinemanager.core.crypto.KeyUnavailableException
import io.github.mcauzzi.cinemanager.core.pairing.PairingQrResult

/** Messaggi in italiano per errori di rete, API e chiave. */
object ErrorText {
    fun of(e: Throwable): UiText = when (e) {
        is ApiException.Network -> text(R.string.error_network)
        is ApiException.Unauthorized -> when (e.reason) {
            "expired", "bad_lifetime" -> text(R.string.error_clock)
            else -> text(R.string.error_unauthorized, e.reason ?: "?")
        }
        is ApiException.DeviceRevoked -> text(R.string.repair_revoked)
        is ApiException.OwnerInactive -> text(R.string.owner_inactive_body)
        is ApiException.Forbidden -> text(R.string.error_forbidden)
        is ApiException.UpgradeRequired -> text(R.string.update_required_title)
        is ApiException.Validation -> e.detail?.let { UiText.Raw(it) }
            ?: e.errors.entries.firstOrNull()?.let { (k, v) -> UiText.Raw("$k: ${v.joinToString(" ")}") }
            ?: text(R.string.error_validation)
        is ApiException.PairingFailed -> when (e.reason) {
            PairFailure.INVALID_CODE -> text(R.string.pair_error_code)
            PairFailure.INVALID_KEY, PairFailure.INVALID_PROOF -> text(R.string.pair_error_key)
            PairFailure.INVALID_REQUEST -> text(R.string.pair_error_name)
            PairFailure.UNKNOWN -> text(R.string.pair_error_generic)
        }
        is ApiException.NotFound -> text(R.string.error_not_found)
        is ApiException.RateLimited -> e.retryAfterSeconds?.let { UiText.Plural(R.plurals.error_rate_limited_s, it.coerceAtMost(3600).toInt()) }
            ?: text(R.string.error_rate_limited)
        is ApiException.TooLarge -> text(R.string.error_too_large)
        is ApiException.TmdbUnavailable -> text(if (e.notConfigured) R.string.error_tmdb_not_configured else R.string.error_tmdb_down)
        is ApiException.Server -> text(R.string.error_server, e.status)
        is KeyUnavailableException -> when (e.kind) {
            KeyUnavailableException.Kind.AUTHENTICATION_REQUIRED -> text(R.string.error_auth_required)
            KeyUnavailableException.Kind.PERMANENTLY_INVALIDATED -> text(R.string.repair_invalidated)
            KeyUnavailableException.Kind.MISSING -> text(R.string.repair_missing)
            KeyUnavailableException.Kind.DEVICE_LOCKED -> text(R.string.error_device_locked)
        }
        else -> text(R.string.error_unexpected, e.message ?: e.javaClass.simpleName)
    }

    fun of(reason: PairingQrResult.Reason): UiText = when (reason) {
        PairingQrResult.Reason.NOT_CINEMANAGER -> text(R.string.qr_error_not_cinemanager)
        PairingQrResult.Reason.UNSUPPORTED_VERSION -> text(R.string.qr_error_version)
        PairingQrResult.Reason.BAD_API -> text(R.string.qr_error_api)
        PairingQrResult.Reason.INSECURE_API -> text(R.string.qr_error_http)
        PairingQrResult.Reason.BAD_CODE -> text(R.string.qr_error_code)
    }
}

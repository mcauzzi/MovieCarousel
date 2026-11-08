package io.github.mcauzzi.cinemanager.ui

import io.github.mcauzzi.cinemanager.R
import io.github.mcauzzi.cinemanager.core.api.ApiException
import io.github.mcauzzi.cinemanager.core.api.ErrorMapper
import io.github.mcauzzi.cinemanager.core.api.PairFailure
import io.github.mcauzzi.cinemanager.core.crypto.KeyUnavailableException
import io.github.mcauzzi.cinemanager.core.pairing.PairingQrResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class ErrorTextTest {
    private fun id(e: Throwable) = (ErrorText.of(e) as UiText.Res).id

    @Test
    fun `errori delle richieste firmate`() {
        assertEquals(R.string.repair_revoked, id(ErrorMapper.map(401, """{"reason":"device_revoked"}""")))
        assertEquals(R.string.error_clock, id(ErrorMapper.map(401, """{"reason":"expired"}""")))
        assertEquals(R.string.error_unauthorized, id(ErrorMapper.map(401, """{"reason":"replay"}""")))
        assertEquals(R.string.owner_inactive_body, id(ErrorMapper.map(403, """{"reason":"owner_inactive"}""")))
        assertEquals(R.string.update_required_title, id(ErrorMapper.map(426, """{"reason":"upgrade_required","minSupportedCode":10100}""")))
        assertEquals(R.string.error_network, id(ApiException.Network(IOException("x"))))
        assertEquals(R.string.error_tmdb_not_configured, id(ApiException.TmdbUnavailable(true)))
    }

    @Test
    fun `errori di abbinamento, chiave e QR`() {
        assertEquals(R.string.pair_error_code, id(ApiException.PairingFailed(PairFailure.INVALID_CODE, null)))
        assertEquals(R.string.repair_invalidated, id(KeyUnavailableException(KeyUnavailableException.Kind.PERMANENTLY_INVALIDATED)))
        assertEquals(R.string.error_auth_required, id(KeyUnavailableException(KeyUnavailableException.Kind.AUTHENTICATION_REQUIRED)))
        assertEquals(R.string.qr_error_http, (ErrorText.of(PairingQrResult.Reason.INSECURE_API) as UiText.Res).id)
    }

    @Test
    fun `validazione con il testo del server`() {
        val e = ErrorMapper.map(400, """{"errors":{"year":["Valore fuori intervallo."]}}""")
        assertEquals(UiText.Raw("year: Valore fuori intervallo."), ErrorText.of(e))
    }

    private fun key(kind: KeyUnavailableException.Kind) = KeyUnavailableException(kind)

    @Test
    fun `errore passeggero del Keystore`() {
        assertEquals(R.string.error_key_temporary, id(key(KeyUnavailableException.Kind.TEMPORARY)))
    }

    @Test
    fun `solo chiave invalidata o mancante cancella l'abbinamento`() {
        assertTrue(ErrorPolicy.forgetsPairing(key(KeyUnavailableException.Kind.PERMANENTLY_INVALIDATED)))
        assertTrue(ErrorPolicy.forgetsPairing(key(KeyUnavailableException.Kind.MISSING)))
        assertFalse(ErrorPolicy.forgetsPairing(key(KeyUnavailableException.Kind.TEMPORARY)))
        assertFalse(ErrorPolicy.forgetsPairing(key(KeyUnavailableException.Kind.DEVICE_LOCKED)))
        assertFalse(ErrorPolicy.forgetsPairing(key(KeyUnavailableException.Kind.AUTHENTICATION_REQUIRED)))
        assertFalse(ErrorPolicy.forgetsPairing(ApiException.Network(IOException("x"))))
    }

    @Test
    fun `Riprova solo per gli errori passeggeri`() {
        assertTrue(ErrorPolicy.retryable(ApiException.Network(IOException("x"))))
        assertTrue(ErrorPolicy.retryable(ErrorMapper.map(429, "")))
        assertTrue(ErrorPolicy.retryable(ErrorMapper.map(503, "")))
        assertTrue(ErrorPolicy.retryable(ApiException.TmdbUnavailable(false)))
        assertTrue(ErrorPolicy.retryable(key(KeyUnavailableException.Kind.TEMPORARY)))
        assertTrue(ErrorPolicy.retryable(key(KeyUnavailableException.Kind.DEVICE_LOCKED)))
        assertFalse(ErrorPolicy.retryable(ApiException.TmdbUnavailable(true)))
        assertFalse(ErrorPolicy.retryable(ErrorMapper.map(400, """{"errors":{"year":["x"]}}""")))
        assertFalse(ErrorPolicy.retryable(ErrorMapper.map(401, """{"reason":"bad_signature"}""")))
    }

    @Test
    fun `scollegamento locale proposto per ogni errore tranne lo sblocco richiesto`() {
        listOf(
            ApiException.Network(IOException("x")),
            ErrorMapper.map(401, """{"reason":"bad_signature"}"""),
            ErrorMapper.map(401, """{"reason":"htu_mismatch"}"""),
            ErrorMapper.map(401, """{"reason":"invalid_token"}"""),
            ErrorMapper.map(403, """{"reason":"owner_inactive"}"""),
            ErrorMapper.map(403, ""),
            ErrorMapper.map(426, """{"reason":"upgrade_required","minSupportedCode":10100}"""),
            ErrorMapper.map(500, ""),
            key(KeyUnavailableException.Kind.TEMPORARY),
            key(KeyUnavailableException.Kind.PERMANENTLY_INVALIDATED),
        ).forEach { assertTrue(it.toString(), ErrorPolicy.offerLocalUnpair(it)) }
        assertFalse(ErrorPolicy.offerLocalUnpair(key(KeyUnavailableException.Kind.AUTHENTICATION_REQUIRED)))
    }
}

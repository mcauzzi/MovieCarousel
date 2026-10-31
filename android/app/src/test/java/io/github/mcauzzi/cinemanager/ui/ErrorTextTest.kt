package io.github.mcauzzi.cinemanager.ui

import io.github.mcauzzi.cinemanager.R
import io.github.mcauzzi.cinemanager.core.api.ApiException
import io.github.mcauzzi.cinemanager.core.api.ErrorMapper
import io.github.mcauzzi.cinemanager.core.api.PairFailure
import io.github.mcauzzi.cinemanager.core.crypto.KeyUnavailableException
import io.github.mcauzzi.cinemanager.core.pairing.PairingQrResult
import org.junit.Assert.assertEquals
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
}

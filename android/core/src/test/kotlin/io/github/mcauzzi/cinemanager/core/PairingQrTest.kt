package io.github.mcauzzi.cinemanager.core

import io.github.mcauzzi.cinemanager.core.pairing.PairingQrParser
import io.github.mcauzzi.cinemanager.core.pairing.PairingQrResult
import io.github.mcauzzi.cinemanager.core.pairing.PairingQrResult.Reason
import org.junit.Assert.assertEquals
import org.junit.Test

class PairingQrTest {
    private fun parse(s: String, allowHttp: Boolean = false) = PairingQrParser.parse(s, allowHttp)
    private fun reason(s: String, allowHttp: Boolean = false) = (parse(s, allowHttp) as PairingQrResult.Invalid).reason

    @Test
    fun `QR del sito`() {
        val r = parse("""{"v":1,"api":"https://cinema.example.org/api","code":"jpg6Ja2nt9yODJ4ib-PhfA"}""") as PairingQrResult.Valid
        assertEquals("https://cinema.example.org/api", r.qr.server.apiBase)
        assertEquals("jpg6Ja2nt9yODJ4ib-PhfA", r.qr.code)
        assertEquals("https://cinema.example.org", r.qr.server.siteRoot)
        assertEquals("https://cinema.example.org/api/app/version", r.qr.server.versionUrl)
        assertEquals("https://cinema.example.org/app/cinemanager.apk", r.qr.server.apkUrl)
        assertEquals("cinema.example.org", r.qr.server.host)
    }

    @Test
    fun `indirizzo normalizzato`() {
        val r = parse("""{"v":1,"api":"HTTPS://Cinema.Example.org:443/api/","code":"abc"}""") as PairingQrResult.Valid
        assertEquals("https://cinema.example.org/api", r.qr.server.apiBase)
        val p = parse("""{"v":1,"api":"https://example.org:8443/sub/api","code":"abc"}""") as PairingQrResult.Valid
        assertEquals("https://example.org:8443/sub", p.qr.server.siteRoot)
    }

    @Test
    fun `http solo nelle build di debug`() {
        val qr = """{"v":1,"api":"http://10.0.2.2:5080/api","code":"abc"}"""
        assertEquals(Reason.INSECURE_API, reason(qr))
        assertEquals("http://10.0.2.2:5080/api", (parse(qr, allowHttp = true) as PairingQrResult.Valid).qr.server.apiBase)
    }

    @Test
    fun `QR non validi`() {
        assertEquals(Reason.NOT_CINEMANAGER, reason("https://example.org"))
        assertEquals(Reason.NOT_CINEMANAGER, reason("[1,2]"))
        assertEquals(Reason.NOT_CINEMANAGER, reason("""{"v":1,"api":"https://example.org/api"}"""))
        assertEquals(Reason.NOT_CINEMANAGER, reason("""{"v":"1","api":"https://example.org/api","code":"a"}"""))
        assertEquals(Reason.UNSUPPORTED_VERSION, reason("""{"v":2,"api":"https://example.org/api","code":"a"}"""))
        assertEquals(Reason.BAD_API, reason("""{"v":1,"api":"ftp://example.org/api","code":"a"}"""))
        assertEquals(Reason.BAD_API, reason("""{"v":1,"api":"https://u:p@example.org/api","code":"a"}"""))
        assertEquals(Reason.BAD_API, reason("""{"v":1,"api":"https://example.org/api?a=1","code":"a"}"""))
        assertEquals(Reason.BAD_CODE, reason("""{"v":1,"api":"https://example.org/api","code":""}"""))
        assertEquals(Reason.BAD_CODE, reason("""{"v":1,"api":"https://example.org/api","code":"a b"}"""))
        assertEquals(Reason.BAD_CODE, reason("""{"v":1,"api":"https://example.org/api","code":"${"a".repeat(65)}"}"""))
    }
}

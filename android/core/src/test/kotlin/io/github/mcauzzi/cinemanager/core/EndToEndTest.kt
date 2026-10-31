package io.github.mcauzzi.cinemanager.core

import io.github.mcauzzi.cinemanager.core.api.ApiException
import io.github.mcauzzi.cinemanager.core.api.CineManagerApi
import io.github.mcauzzi.cinemanager.core.api.DeviceCredentials
import io.github.mcauzzi.cinemanager.core.pairing.PairingQrParser
import io.github.mcauzzi.cinemanager.core.pairing.PairingQrResult
import io.github.mcauzzi.cinemanager.core.pairing.ServerUrls
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Verifica contro l'API vera (stessa logica di firma del server). Facoltativo: gira solo con
 * `CM_E2E_API=http://localhost:5080` e l'API avviata in Development con l'utente finto
 * (`cd api/CineManager.Api && dotnet run`), che può creare codici di abbinamento.
 */
class EndToEndTest {
    private val base = System.getenv("CM_E2E_API")?.trimEnd('/').orEmpty()

    @Test
    fun `abbinamento e richieste firmate accettate dal server`() = runBlocking<Unit> {
        assumeTrue("CM_E2E_API non impostata", base.isNotEmpty())
        val http = OkHttpClient()
        // 1. codice di abbinamento dal "sito" (autenticazione di sviluppo)
        val pairing = http.newCall(
            Request.Builder().url("$base/api/pairing").header("X-CM-Request", "1").post(ByteArray(0).toRequestBody()).build(),
        ).execute().use { res ->
            assertEquals(200, res.code)
            Json.parseToJsonElement(res.body!!.string()) as JsonObject
        }
        val code = pairing["code"]!!.jsonPrimitive.content
        // Stesso JSON del QR del sito
        val qr = PairingQrParser.parse("""{"v":1,"api":"$base/api","code":"$code"}""", allowHttp = true) as PairingQrResult.Valid

        // 2. abbinamento con prova di possesso
        val key = TestKeys.random()
        val anon = CineManagerApi(qr.qr.server, CineManagerApi.defaultClient(), null, 10000)
        val paired = anon.pair(qr.qr.code, "Test JVM", key)

        // 3. richieste firmate dal codice Kotlin
        val api = CineManagerApi(ServerUrls.trusted("$base/api"), CineManagerApi.defaultClient(),
            DeviceCredentials(paired.deviceId, key), 10000)
        val me = api.me()
        assertEquals(paired.deviceId, me.deviceId)
        assertEquals("Test JVM", me.deviceName)
        assertTrue(api.fields().any { it.name == "title" })
        try {
            api.lookup("8012345678901") // con query; TMDb/provider possono non essere configurati
        } catch (e: ApiException) {
            // Un errore applicativo (TMDb non configurato...) va bene: conta che la firma sia
            // stata accettata, cioè niente 401/403/426 né errori di rete.
            if (e is ApiException.Unauthorized || e is ApiException.DeviceRevoked || e is ApiException.Network ||
                e is ApiException.UpgradeRequired || e is ApiException.OwnerInactive
            ) throw e
        }

        // 4. scollega → il dispositivo risulta revocato
        api.unpair()
        try {
            api.me()
            throw AssertionError("atteso 401 device_revoked")
        } catch (_: ApiException.DeviceRevoked) {
        }
    }
}

package io.github.mcauzzi.cinemanager.core

import io.github.mcauzzi.cinemanager.core.api.ApiException
import io.github.mcauzzi.cinemanager.core.api.CineManagerApi
import io.github.mcauzzi.cinemanager.core.api.CreateMovieResult
import io.github.mcauzzi.cinemanager.core.api.DeviceCredentials
import io.github.mcauzzi.cinemanager.core.api.NewMovieRequest
import io.github.mcauzzi.cinemanager.core.api.PairFailure
import io.github.mcauzzi.cinemanager.core.api.UpdateState
import io.github.mcauzzi.cinemanager.core.api.stateFor
import io.github.mcauzzi.cinemanager.core.crypto.Base64Url
import io.github.mcauzzi.cinemanager.core.crypto.DeviceKey
import io.github.mcauzzi.cinemanager.core.crypto.KeyUnavailableException
import io.github.mcauzzi.cinemanager.core.pairing.ServerUrls
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.Base64

class CineManagerApiTest {
    private lateinit var server: MockWebServer
    private val key = TestKeys.random()
    private val deviceId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"

    @Before fun start() { server = MockWebServer().apply { start() } }
    @After fun stop() { server.shutdown() }

    private fun urls() = ServerUrls.trusted(server.url("/api").toString())
    private fun api(creds: DeviceCredentials? = DeviceCredentials(deviceId, key), av: Int = 10300) =
        CineManagerApi(urls(), CineManagerApi.defaultClient(), creds, av)

    private fun json(body: String, code: Int = 200) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private fun problem(code: Int, reason: String, extra: String = "") =
        json("""{"type":"x","title":"t","status":$code,"reason":"$reason"$extra}""", code)
            .setHeader("Content-Type", "application/problem+json")

    @Test
    fun `richiesta firmata con htu uguale al request-target e bh del corpo`() = runBlocking<Unit> {
        server.enqueue(json("""{"id":1000000}""", 201))
        val movie = buildJsonObject { put("title", "Il padrino"); put("year", 1972) }
        val res = api().createMovie(NewMovieRequest(ean = "8012345678901", movie = movie))
        assertEquals(CreateMovieResult.Created(1000000), res)

        val rec = server.takeRequest()
        val auth = rec.getHeader("Authorization")!!
        assertTrue(auth.startsWith("CM-Device "))
        val body = rec.body.readByteArray()
        val parsed = ServerRules.verify(auth.removePrefix("CM-Device "), key.publicKeySpki, rec.method!!, rec.path!!, body,
            System.currentTimeMillis() / 1000)
        assertNotNull("il server accetterebbe il token", parsed)
        assertEquals("/api/app/movies", parsed!!.htu)
        assertEquals(deviceId, parsed.kid.toString())
        assertEquals(10300, parsed.av)
        // Corpo: niente null (explicitNulls = false), confirmDuplicate sempre presente.
        val sent = Json.parseToJsonElement(body.decodeToString()) as JsonObject
        assertEquals(setOf("ean", "movie", "confirmDuplicate"), sent.keys)
        assertNull(rec.getHeader("X-CM-Request"))
    }

    @Test
    fun `query codificata come la invia OkHttp`() = runBlocking<Unit> {
        server.enqueue(json("""{"candidates":[{"tmdbId":238,"title":"Il padrino","year":1972}]}"""))
        val c = api().search("il padrino & co+", 1972)
        assertEquals(238, c.single().tmdbId)
        val rec = server.takeRequest()
        val token = rec.getHeader("Authorization")!!.removePrefix("CM-Device ")
        val p = ServerRules.verify(token, key.publicKeySpki, "GET", rec.path!!, null, System.currentTimeMillis() / 1000)
        assertNotNull(p)
        assertTrue(rec.path!!.startsWith("/api/app/search?q="))
        assertNull(p!!.bh)
    }

    @Test
    fun `ogni richiesta ha un jti nuovo`() = runBlocking<Unit> {
        repeat(2) { server.enqueue(json("""{"deviceId":"$deviceId","deviceName":"P","user":{"name":"Anna"}}""")) }
        val a = api()
        assertEquals("Anna", a.me().user.name)
        a.me()
        val j1 = jti(server.takeRequest().getHeader("Authorization")!!)
        val j2 = jti(server.takeRequest().getHeader("Authorization")!!)
        assertNotEquals(j1, j2)
    }

    private fun jti(auth: String): String {
        val payload = Base64Url.decode(auth.removePrefix("CM-Device ").split('.')[1])!!.decodeToString()
        return (Json.parseToJsonElement(payload) as JsonObject)["jti"]!!.jsonPrimitive.content
    }

    @Test
    fun `pair non firmato con prova di possesso`() = runBlocking<Unit> {
        server.enqueue(json("""{"deviceId":"$deviceId","user":{"name":"Anna"}}"""))
        val res = api(creds = null).pair("jpg6Ja2nt9yODJ4ib-PhfA", "Pixel 8", key)
        assertEquals(deviceId, res.deviceId)
        val rec = server.takeRequest()
        assertEquals("/api/app/pair", rec.path)
        assertNull(rec.getHeader("Authorization"))
        val body = Json.parseToJsonElement(rec.body.readUtf8()) as JsonObject
        assertEquals("Pixel 8", body["deviceName"]!!.jsonPrimitive.content)
        assertEquals(Base64.getEncoder().encodeToString(key.publicKeySpki), body["publicKey"]!!.jsonPrimitive.content)
        assertEquals(64, Base64Url.decode(body["proof"]!!.jsonPrimitive.content)!!.size)
    }

    @Test
    fun `errori di pair`() = runBlocking<Unit> {
        server.enqueue(problem(400, "invalid_code"))
        try {
            api(creds = null).pair("x", "P", key); fail()
        } catch (e: ApiException.PairingFailed) {
            assertEquals(PairFailure.INVALID_CODE, e.reason)
        }
    }

    @Test
    fun `409 ean e possible_duplicate sono esiti`() = runBlocking<Unit> {
        server.enqueue(json("""{"reason":"ean","existingId":12,"title":"Il padrino"}""", 409))
        server.enqueue(json("""{"reason":"possible_duplicate","candidates":[{"id":12,"title":"Il padrino","year":1972}]}""", 409))
        val m = JsonObject(mapOf("title" to JsonPrimitive("Il padrino")))
        assertEquals(CreateMovieResult.EanExists(12, "Il padrino"), api().createMovie(NewMovieRequest(movie = m)))
        val d = api().createMovie(NewMovieRequest(movie = m)) as CreateMovieResult.PossibleDuplicate
        assertEquals(12L, d.candidates.single().id)
    }

    @Test
    fun `mappatura degli errori dell'autenticazione`() = runBlocking<Unit> {
        server.enqueue(problem(401, "device_revoked").setHeader("WWW-Authenticate", "CM-Device"))
        server.enqueue(problem(401, "expired"))
        server.enqueue(problem(403, "owner_inactive"))
        server.enqueue(problem(426, "upgrade_required", ""","minSupportedCode":10200"""))
        server.enqueue(problem(429, "x").setHeader("Retry-After", "17"))
        val a = api()
        expect<ApiException.DeviceRevoked> { a.me() }
        assertEquals("expired", expect<ApiException.Unauthorized> { a.me() }.reason)
        expect<ApiException.OwnerInactive> { a.me() }
        assertEquals(10200, expect<ApiException.UpgradeRequired> { a.me() }.minSupportedCode)
        assertEquals(17L, expect<ApiException.RateLimited> { a.me() }.retryAfterSeconds)
    }

    @Test
    fun `errori di validazione per campo e TMDb non disponibile`() = runBlocking<Unit> {
        server.enqueue(json("""{"title":"One or more validation errors occurred.","status":400,"errors":{"year":["Valore fuori intervallo (1870–2031)."]}}""", 400))
        server.enqueue(problem(503, "x"))
        val e = expect<ApiException.Validation> { api().createMovie(NewMovieRequest(movie = JsonObject(emptyMap()))) }
        assertEquals(listOf("Valore fuori intervallo (1870–2031)."), e.errors["year"])
        assertTrue(expect<ApiException.TmdbUnavailable> { api().tmdb(238) }.notConfigured)
    }

    @Test
    fun `chiave non disponibile arriva al chiamante`() = runBlocking<Unit> {
        val locked = object : DeviceKey {
            override val publicKeySpki = key.publicKeySpki
            override fun signDer(data: ByteArray): ByteArray =
                throw KeyUnavailableException(KeyUnavailableException.Kind.AUTHENTICATION_REQUIRED)
        }
        server.enqueue(json("{}"))
        try {
            api(DeviceCredentials(deviceId, locked)).fields(); fail()
        } catch (e: KeyUnavailableException) {
            assertEquals(KeyUnavailableException.Kind.AUTHENTICATION_REQUIRED, e.kind)
        }
        assertEquals(0, server.requestCount)
        // Senza abbinamento le chiamate firmate non partono.
        expectKey { api(creds = null).me() }
    }

    @Test
    fun `rete assente`() = runBlocking<Unit> {
        val dead = ServerUrls.trusted("http://127.0.0.1:1/api")
        val a = CineManagerApi(dead, CineManagerApi.defaultClient(), DeviceCredentials(deviceId, key), 1)
        expect<ApiException.Network> { a.me() }
    }

    @Test
    fun `versione dell'app`() = runBlocking<Unit> {
        server.enqueue(json("""{"version":"1.3.0","versionCode":10300,"minSupportedCode":10100,"sha256":"ab","commit":"c"}"""))
        server.enqueue(MockResponse().setResponseCode(404))
        server.enqueue(MockResponse().setBody("<!doctype html>"))
        val v = api(creds = null).appVersion()!!
        assertEquals("/api/app/version", server.takeRequest().path)
        assertEquals(UpdateState.UPDATE_REQUIRED, v.stateFor(10000))
        assertEquals(UpdateState.UPDATE_AVAILABLE, v.stateFor(10100))
        assertEquals(UpdateState.UP_TO_DATE, v.stateFor(10300))
        assertNull(api(creds = null).appVersion())
        assertNull(api(creds = null).appVersion())
    }

    @Test
    fun `nessun redirect seguito`() = runBlocking<Unit> {
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://login.example.org/"))
        val e = expect<ApiException.Server> { api().me() }
        assertEquals(302, e.status)
        assertEquals(1, server.requestCount)
    }

    private suspend inline fun <reified T : Throwable> expect(block: suspend () -> Unit): T {
        try {
            block()
        } catch (e: Throwable) {
            if (e is T) return e
            throw AssertionError("Attesa ${T::class.simpleName}, ricevuta $e", e)
        }
        throw AssertionError("Attesa ${T::class.simpleName}, nessuna eccezione")
    }

    private suspend fun expectKey(block: suspend () -> Unit) {
        assertEquals(KeyUnavailableException.Kind.MISSING, expect<KeyUnavailableException>(block).kind)
    }
}

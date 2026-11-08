package io.github.mcauzzi.cinemanager.core

import io.github.mcauzzi.cinemanager.core.crypto.Base64Url
import io.github.mcauzzi.cinemanager.core.crypto.EcdsaSignatures
import io.github.mcauzzi.cinemanager.core.crypto.PairingProof
import io.github.mcauzzi.cinemanager.core.crypto.RequestTokenFactory
import io.github.mcauzzi.cinemanager.core.crypto.signJose
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

class RequestTokensTest {
    private val key = TestKeys.fixed()
    private val factory = RequestTokenFactory(key, nowSeconds = { Vectors.IAT })

    private fun segments(token: String) = token.split('.').also { assertEquals(3, it.size) }
    private fun json(segment: String) = Json.parseToJsonElement(Base64Url.decode(segment)!!.decodeToString()) as JsonObject

    private fun kotlinToken(method: String, path: String, body: ByteArray?) =
        factory.create(Vectors.DEVICE_ID, method, path, body, Vectors.AV, iat = Vectors.IAT, jti = Vectors.JTI)

    @Test
    fun `payload identico byte per byte a sign-request`() {
        val get = kotlinToken("GET", Vectors.GET_PATH, null)
        assertEquals(segments(Vectors.GET_TOKEN)[1], segments(get)[1])

        val post = kotlinToken("POST", Vectors.POST_PATH, Vectors.POST_BODY.toByteArray())
        assertEquals(segments(Vectors.POST_TOKEN)[1], segments(post)[1])
    }

    @Test
    fun `header uguale a sign-request salvo l'escape di System Text Json`() {
        val kotlin = segments(kotlinToken("GET", Vectors.GET_PATH, null))[0]
        val dotnet = segments(Vectors.GET_TOKEN)[0]
        // .NET scrive "cm-req+jwt" (escape del '+' del JavaScriptEncoder di default): stesso JSON.
        assertEquals(json(dotnet), json(kotlin))
        assertEquals(listOf("alg", "typ", "kid"), json(kotlin).keys.toList())
        assertEquals("""{"alg":"ES256","typ":"cm-req+jwt","kid":"${Vectors.DEVICE_ID}"}""", Base64Url.decode(kotlin)!!.decodeToString())
    }

    @Test
    fun `claim nell'ordine di sign-request e bh solo con il corpo`() {
        val get = json(segments(kotlinToken("GET", Vectors.GET_PATH, null))[1])
        assertEquals(listOf("iat", "exp", "jti", "htm", "htu", "av"), get.keys.toList())
        val post = json(segments(kotlinToken("POST", Vectors.POST_PATH, Vectors.POST_BODY.toByteArray()))[1])
        assertEquals(listOf("iat", "exp", "jti", "htm", "htu", "av", "bh"), post.keys.toList())
        // Corpo vuoto = nessun bh, come sign-request.
        assertEquals(listOf("iat", "exp", "jti", "htm", "htu", "av"),
            json(segments(kotlinToken("DELETE", "/api/app/me", ByteArray(0)))[1]).keys.toList())
    }

    @Test
    fun `firma ES256 in formato JOSE R concatenato S, non DER`() {
        val token = kotlinToken("GET", Vectors.GET_PATH, null)
        val sig = Base64Url.decode(segments(token)[2])!!
        assertEquals(64, sig.size)
        assertNotNull(ServerRules.verify(token, key.publicKeySpki, "GET", Vectors.GET_PATH, null, Vectors.IAT))
        // Nessun padding e solo alfabeto base64url.
        assertTrue(token.all { it.isLetterOrDigit() || it == '-' || it == '_' || it == '.' })
    }

    @Test
    fun `i token di sign-request passano la stessa verifica`() {
        val spki = Base64.getDecoder().decode(TestKeys.SPKI)
        assertNotNull(ServerRules.verify(Vectors.GET_TOKEN, spki, "GET", Vectors.GET_PATH, null, Vectors.IAT))
        assertNotNull(ServerRules.verify(Vectors.POST_TOKEN, spki, "POST", Vectors.POST_PATH, Vectors.POST_BODY.toByteArray(), Vectors.IAT))
    }

    @Test
    fun `token alterati o fuori tempo rifiutati`() {
        val body = Vectors.POST_BODY.toByteArray()
        val token = kotlinToken("POST", Vectors.POST_PATH, body)
        val spki = key.publicKeySpki
        assertNotNull(ServerRules.verify(token, spki, "POST", Vectors.POST_PATH, body, Vectors.IAT + 50))
        assertNull(ServerRules.verify(token, spki, "POST", Vectors.POST_PATH, body, Vectors.IAT + 91)) // scaduto
        assertNull(ServerRules.verify(token, spki, "POST", "/api/app/movies?x=1", body, Vectors.IAT)) // htu
        assertNull(ServerRules.verify(token, spki, "PUT", Vectors.POST_PATH, body, Vectors.IAT)) // htm
        assertNull(ServerRules.verify(token, spki, "POST", Vectors.POST_PATH, "{}".toByteArray(), Vectors.IAT)) // bh
        assertNull(ServerRules.verify(token, TestKeys.random().publicKeySpki, "POST", Vectors.POST_PATH, body, Vectors.IAT)) // chiave
    }

    @Test
    fun `jti casuale di 128 bit e exp a 60 secondi`() {
        val a = factory.newJti()
        val b = factory.newJti()
        assertNotEquals(a, b)
        assertEquals(22, a.length)
        assertEquals(16, Base64Url.decode(a)!!.size)
        val p = ServerRules.verify(
            factory.create(Vectors.DEVICE_ID, "get", "/api/app/me", null, 7),
            key.publicKeySpki, "GET", "/api/app/me", null, Vectors.IAT,
        )!!
        assertEquals(60, p.exp - p.iat)
        assertEquals(7, p.av)
        assertEquals("GET", p.htm)
    }

    @Test
    fun `bh uguale a quello di sign-request`() {
        assertEquals("YMbnoxFjisq9xGXoYTCb6IEcjIHoe93aOhr20qWOnqA", RequestTokenFactory.bodyHash(Vectors.POST_BODY.toByteArray()))
    }

    @Test
    fun `prova di possesso dell'abbinamento`() {
        val proof = PairingProof.create(key, Vectors.PAIR_CODE)
        assertTrue(verifyJose(TestKeys.SPKI, "pair:${Vectors.PAIR_CODE}", proof))
        // Quella prodotta da .NET con la stessa chiave è verificabile allo stesso modo.
        assertTrue(verifyJose(TestKeys.SPKI, "pair:${Vectors.PAIR_CODE}", Vectors.PAIR_PROOF))
        assertTrue(!verifyJose(TestKeys.SPKI, "pair:altro", proof))
    }

    @Test
    fun `DER e JOSE si convertono avanti e indietro`() {
        repeat(200) {
            val k = TestKeys.random()
            val data = "dato $it".toByteArray()
            val der = k.signDer(data)
            val jose = EcdsaSignatures.derToJose(der)
            assertEquals(64, jose.size)
            assertArrayEquals(der, TestSignatures.joseToDer(jose))
            assertTrue(verifyJose(Base64.getEncoder().encodeToString(k.publicKeySpki), String(data), Base64Url.encode(k.signJose(data))))
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun `DER malformato rifiutato`() {
        EcdsaSignatures.derToJose(byteArrayOf(0x30, 0x03, 0x02, 0x01))
    }

    @Test
    fun `componenti corte vengono riempite a 32 byte`() {
        // r = 1, s = 0x80 (serve lo zero iniziale nel DER)
        val der = byteArrayOf(0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x02, 0x00, 0x80.toByte())
        val jose = EcdsaSignatures.derToJose(der)
        assertEquals(1, jose[31].toInt())
        assertEquals(0x80, jose[63].toInt() and 0xFF)
        assertTrue(jose.copyOfRange(0, 31).all { it.toInt() == 0 })
        assertArrayEquals(der, TestSignatures.joseToDer(jose))
    }

    private fun verifyJose(spkiB64: String, data: String, sigB64Url: String): Boolean {
        val pub = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(spkiB64)))
        val sig = Base64Url.decode(sigB64Url) ?: return false
        if (sig.size != 64) return false
        return Signature.getInstance("SHA256withECDSA").run {
            initVerify(pub)
            update(data.toByteArray(Charsets.UTF_8))
            verify(TestSignatures.joseToDer(sig))
        }
    }
}

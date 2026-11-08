package io.github.mcauzzi.cinemanager.core

import io.github.mcauzzi.cinemanager.core.crypto.Base64Url
import io.github.mcauzzi.cinemanager.core.crypto.RequestTokenFactory
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.UUID

/**
 * Trascrizione in Kotlin dei controlli di `api/CineManager.Api/Auth/DeviceTokens.cs` (TryParse +
 * VerifySignature) e dei passi 2–3 di `DeviceAuthHandler`, per i test sulla JVM. La verifica
 * contro il server vero è in `EndToEndTest` (facoltativo, con l'API avviata).
 */
object ServerRules {
    data class Parsed(val kid: UUID, val iat: Long, val exp: Long, val jti: String, val htm: String, val htu: String, val bh: String?, val av: Int)

    /** null se il server rifiuterebbe il token; altrimenti i claim. */
    fun verify(token: String, spki: ByteArray, method: String, target: String, body: ByteArray?, now: Long): Parsed? {
        if (token.isEmpty() || token.length > 4096) return null
        val parts = token.split('.')
        if (parts.size != 3) return null
        val headerBytes = Base64Url.decode(parts[0]) ?: return null
        val payloadBytes = Base64Url.decode(parts[1]) ?: return null
        val sig = Base64Url.decode(parts[2]) ?: return null
        if (sig.size != 64) return null
        val h = Json.parseToJsonElement(headerBytes.decodeToString()) as? JsonObject ?: return null
        if (h.str("alg") != "ES256" || h.str("typ") != "cm-req+jwt" || "crit" in h) return null
        val kid = h.str("kid")?.let { runCatching { UUID.fromString(it) }.getOrNull() } ?: return null
        val p = Json.parseToJsonElement(payloadBytes.decodeToString()) as? JsonObject ?: return null
        val iat = (p["iat"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull ?: return null
        val exp = (p["exp"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull ?: return null
        val jti = p.str("jti")?.takeIf { it.length in 16..128 } ?: return null
        val htm = p.str("htm")?.takeIf { it.isNotEmpty() } ?: return null
        val htu = p.str("htu")?.takeIf { it.isNotEmpty() } ?: return null
        val bh = if ("bh" in p) p.str("bh") ?: return null else null
        val av = (p["av"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull?.takeIf { it >= 0 } ?: return null

        val pub = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki))
        val ok = Signature.getInstance("SHA256withECDSA").run {
            initVerify(pub)
            update((parts[0] + "." + parts[1]).toByteArray(Charsets.US_ASCII))
            verify(TestSignatures.joseToDer(sig))
        }
        if (!ok) return null
        if (exp <= iat || exp - iat > 60) return null
        if (iat > now + 30 || exp < now - 30) return null
        if (htm != method || htu != target) return null
        val b = body ?: ByteArray(0)
        if (b.isNotEmpty() && bh == null) return null
        if (bh != null && bh != RequestTokenFactory.bodyHash(b)) return null
        return Parsed(kid, iat, exp, jti, htm, htu, bh, av)
    }

    private fun JsonObject.str(n: String) = (this[n] as? JsonPrimitive)?.takeIf { it.isString }?.content
}

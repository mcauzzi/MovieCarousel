package io.github.mcauzzi.cinemanager.core.crypto

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * JWT delle richieste firmate (docs/api.md, "Richieste firmate dell'app"):
 *
 * ```
 * header : { "alg": "ES256", "typ": "cm-req+jwt", "kid": "<deviceId>" }
 * payload: { "iat", "exp" = iat + 60, "jti", "htm", "htu", "av", "bh"? }
 * firma  : ES256 su "<header>.<payload>", R||S (64 byte), base64url senza padding
 * ```
 *
 * L'ordine delle chiavi e la serializzazione compatta sono gli stessi di `api/tools/sign-request`.
 */
class RequestTokenFactory(
    private val key: DeviceKey,
    private val nowSeconds: () -> Long = { System.currentTimeMillis() / 1000 },
    private val random: SecureRandom = SecureRandom(),
) {
    fun create(
        deviceId: String,
        method: String,
        pathAndQuery: String,
        body: ByteArray?,
        appVersionCode: Int,
        iat: Long = nowSeconds(),
        jti: String = newJti(),
    ): String {
        val input = Base64Url.encode(headerJson(deviceId).toByteArray(Charsets.UTF_8)) + "." +
            Base64Url.encode(payloadJson(iat, jti, method, pathAndQuery, body, appVersionCode).toByteArray(Charsets.UTF_8))
        return input + "." + Base64Url.encode(key.signJose(input.toByteArray(Charsets.US_ASCII)))
    }

    /** 128 bit casuali in base64url (22 caratteri; il server ne accetta 16–128). */
    fun newJti(): String = ByteArray(16).also(random::nextBytes).let(Base64Url::encode)

    companion object {
        const val AUTHORIZATION_PREFIX = "CM-Device "
        const val TYPE = "cm-req+jwt"
        const val ALGORITHM = "ES256"
        const val LIFETIME_SECONDS = 60L

        fun headerJson(deviceId: String): String = buildJsonObject {
            put("alg", ALGORITHM)
            put("typ", TYPE)
            put("kid", deviceId)
        }.toString()

        fun payloadJson(
            iat: Long,
            jti: String,
            method: String,
            pathAndQuery: String,
            body: ByteArray?,
            appVersionCode: Int,
        ): String = buildJsonObject {
            put("iat", iat)
            put("exp", iat + LIFETIME_SECONDS)
            put("jti", jti)
            put("htm", method.uppercase())
            put("htu", pathAndQuery)
            put("av", appVersionCode)
            if (body != null && body.isNotEmpty()) put("bh", bodyHash(body))
        }.toString()

        /** Base64url dello SHA-256 del corpo (claim `bh`). */
        fun bodyHash(body: ByteArray): String =
            Base64Url.encode(MessageDigest.getInstance("SHA-256").digest(body))
    }
}

/** Prova di possesso dell'abbinamento: ES256 (R||S, base64url) di `"pair:" + code`. */
object PairingProof {
    fun create(key: DeviceKey, code: String): String =
        Base64Url.encode(key.signJose("pair:$code".toByteArray(Charsets.UTF_8)))
}

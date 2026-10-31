package io.github.mcauzzi.cinemanager.core.crypto

import java.io.IOException
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature

/**
 * Chiave del dispositivo (EC P-256). Sul telefono la privata sta nell'Android Keystore e non
 * esce mai; nei test è una chiave software. La firma passa sempre da JCA `SHA256withECDSA`.
 */
interface DeviceKey {
    /** Chiave pubblica in formato SPKI DER (quella inviata a `POST /api/app/pair`). */
    val publicKeySpki: ByteArray

    /** Firma `SHA256withECDSA` nel formato DER di JCA. */
    fun signDer(data: ByteArray): ByteArray
}

/** Firma ES256: `R||S` a 64 byte. */
fun DeviceKey.signJose(data: ByteArray): ByteArray = EcdsaSignatures.derToJose(signDer(data))

/** [DeviceKey] su chiavi JCA (Android Keystore o software). */
open class JcaDeviceKey(
    private val privateKey: PrivateKey,
    publicKey: PublicKey,
) : DeviceKey {
    override val publicKeySpki: ByteArray = publicKey.encoded

    override fun signDer(data: ByteArray): ByteArray =
        Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey)
            update(data)
            sign()
        }
}

/**
 * La chiave non può firmare adesso. È una [IOException] perché attraversa gli interceptor di
 * OkHttp e arriva intatta al chiamante.
 */
class KeyUnavailableException(val kind: Kind, cause: Throwable? = null) :
    IOException("Chiave del dispositivo non disponibile: $kind", cause) {
    enum class Kind {
        /** Serve sbloccare con impronta o PIN (finestra di 10 minuti scaduta). */
        AUTHENTICATION_REQUIRED,

        /** Chiave invalidata da Android (blocco schermo cambiato, nuova impronta): rifare l'abbinamento. */
        PERMANENTLY_INVALIDATED,

        /** Nessuna chiave: il dispositivo non è abbinato. */
        MISSING,

        /** Telefono bloccato (`setUnlockedDeviceRequired`). */
        DEVICE_LOCKED,
    }
}

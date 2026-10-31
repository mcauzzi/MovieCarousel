package io.github.mcauzzi.cinemanager.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import io.github.mcauzzi.cinemanager.core.crypto.DeviceKey
import io.github.mcauzzi.cinemanager.core.crypto.JcaDeviceKey
import io.github.mcauzzi.cinemanager.core.crypto.KeyUnavailableException
import io.github.mcauzzi.cinemanager.core.crypto.KeyUnavailableException.Kind
import java.security.GeneralSecurityException
import java.security.InvalidKeyException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.spec.ECGenParameterSpec

/**
 * Chiave EC P-256 del dispositivo nell'Android Keystore (docs/scanner-dvd.md §4.2, §11):
 * non esportabile, StrongBox se disponibile, utilizzabile solo a telefono sbloccato e, con
 * l'opzione "Chiedi impronta all'apertura", solo nei 10 minuti dopo un'impronta o il PIN.
 */
object DeviceKeyStore {
    private const val PROVIDER = "AndroidKeyStore"
    private const val ALIAS = "cinemanager-device"

    /** Finestra di validità dell'autenticazione (§4.2): una conferma per sessione di scansioni. */
    const val AUTH_VALIDITY_SECONDS = 600

    private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    fun exists(): Boolean = runCatching { keyStore().containsAlias(ALIAS) }.getOrDefault(false)

    fun delete() {
        runCatching { keyStore().deleteEntry(ALIAS) }
    }

    /** Chiave esistente o null. */
    fun load(): DeviceKey? {
        val ks = keyStore()
        val entry = ks.getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry ?: return null
        return KeystoreDeviceKey(entry.privateKey, entry.certificate.publicKey)
    }

    /** Nuova coppia di chiavi (sostituisce l'eventuale precedente). */
    fun generate(requireUserAuth: Boolean): DeviceKey {
        delete()
        try {
            generate(requireUserAuth, strongBox = true)
        } catch (_: ProviderException) {
            // StrongBoxUnavailableException, o una ProviderException generica su alcuni dispositivi.
            generate(requireUserAuth, strongBox = false)
        }
        return load() ?: throw KeyUnavailableException(Kind.MISSING)
    }

    private fun generate(requireUserAuth: Boolean, strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUnlockedDeviceRequired(true)
            .setIsStrongBoxBacked(strongBox)
            .apply {
                if (requireUserAuth) {
                    setUserAuthenticationRequired(true)
                    setUserAuthenticationParameters(
                        AUTH_VALIDITY_SECONDS,
                        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                    )
                }
            }
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).run {
            initialize(spec)
            generateKeyPair()
        }
    }
}

/** Firma con la chiave del Keystore, traducendo le eccezioni di Android in [KeyUnavailableException]. */
private class KeystoreDeviceKey(privateKey: PrivateKey, publicKey: java.security.PublicKey) : DeviceKey {
    private val jca = JcaDeviceKey(privateKey, publicKey)
    override val publicKeySpki: ByteArray = jca.publicKeySpki

    override fun signDer(data: ByteArray): ByteArray = try {
        jca.signDer(data)
    } catch (e: UserNotAuthenticatedException) {
        throw KeyUnavailableException(Kind.AUTHENTICATION_REQUIRED, e)
    } catch (e: KeyPermanentlyInvalidatedException) {
        throw KeyUnavailableException(Kind.PERMANENTLY_INVALIDATED, e)
    } catch (e: InvalidKeyException) {
        // setUnlockedDeviceRequired: a telefono bloccato la chiave non si può usare.
        throw KeyUnavailableException(Kind.DEVICE_LOCKED, e)
    } catch (e: GeneralSecurityException) {
        throw KeyUnavailableException(Kind.PERMANENTLY_INVALIDATED, e)
    }
}

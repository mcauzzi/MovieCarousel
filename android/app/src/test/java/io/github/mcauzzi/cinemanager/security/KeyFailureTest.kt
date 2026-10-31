package io.github.mcauzzi.cinemanager.security

import io.github.mcauzzi.cinemanager.core.crypto.KeyUnavailableException.Kind
import org.junit.Assert.assertEquals
import org.junit.Test

class KeyFailureTest {
    private fun kind(f: KeyFailure, requiresAuth: Boolean = false, locked: Boolean = false) =
        KeyFailure.classify(f, requiresAuth, locked)

    @Test
    fun `solo la chiave invalidata da Android fa rifare l'abbinamento`() {
        assertEquals(Kind.PERMANENTLY_INVALIDATED, kind(KeyFailure.PERMANENTLY_INVALIDATED))
        assertEquals(Kind.PERMANENTLY_INVALIDATED, kind(KeyFailure.PERMANENTLY_INVALIDATED, requiresAuth = true, locked = true))
        // Altri errori del Keystore: passeggeri, la chiave resta.
        assertEquals(Kind.TEMPORARY, kind(KeyFailure.OTHER))
        assertEquals(Kind.TEMPORARY, kind(KeyFailure.INVALID_KEY))
    }

    @Test
    fun `telefono bloccato distinto dagli errori generici`() {
        assertEquals(Kind.DEVICE_LOCKED, kind(KeyFailure.INVALID_KEY, locked = true))
        assertEquals(Kind.DEVICE_LOCKED, kind(KeyFailure.OTHER, locked = true))
    }

    @Test
    fun `sblocco richiesto solo se la chiave chiede l'autenticazione`() {
        assertEquals(Kind.AUTHENTICATION_REQUIRED, kind(KeyFailure.USER_NOT_AUTHENTICATED, requiresAuth = true))
        assertEquals(Kind.AUTHENTICATION_REQUIRED, kind(KeyFailure.USER_NOT_AUTHENTICATED, requiresAuth = true, locked = true))
        assertEquals(Kind.DEVICE_LOCKED, kind(KeyFailure.USER_NOT_AUTHENTICATED, requiresAuth = false, locked = true))
        assertEquals(Kind.TEMPORARY, kind(KeyFailure.USER_NOT_AUTHENTICATED, requiresAuth = false, locked = false))
    }
}

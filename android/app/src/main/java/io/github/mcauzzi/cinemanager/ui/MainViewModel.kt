package io.github.mcauzzi.cinemanager.ui

import android.app.Application
import android.os.Build
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.mcauzzi.cinemanager.BuildConfig
import io.github.mcauzzi.cinemanager.R
import io.github.mcauzzi.cinemanager.core.api.ApiException
import io.github.mcauzzi.cinemanager.core.api.Candidate
import io.github.mcauzzi.cinemanager.core.api.CineManagerApi
import io.github.mcauzzi.cinemanager.core.api.CreateMovieResult
import io.github.mcauzzi.cinemanager.core.api.DeviceCredentials
import io.github.mcauzzi.cinemanager.core.api.DuplicateRef
import io.github.mcauzzi.cinemanager.core.api.LookupResponse
import io.github.mcauzzi.cinemanager.core.api.NewMovieRequest
import io.github.mcauzzi.cinemanager.core.api.UpdateState
import io.github.mcauzzi.cinemanager.core.api.stateFor
import io.github.mcauzzi.cinemanager.core.crypto.DeviceKey
import io.github.mcauzzi.cinemanager.core.crypto.KeyUnavailableException
import io.github.mcauzzi.cinemanager.core.form.Ean
import io.github.mcauzzi.cinemanager.core.form.FieldValue
import io.github.mcauzzi.cinemanager.core.form.FormField
import io.github.mcauzzi.cinemanager.core.form.MovieForm
import io.github.mcauzzi.cinemanager.core.pairing.PairingQrParser
import io.github.mcauzzi.cinemanager.core.pairing.PairingQrResult
import io.github.mcauzzi.cinemanager.core.pairing.ServerUrls
import io.github.mcauzzi.cinemanager.data.Pairing
import io.github.mcauzzi.cinemanager.data.PairingStore
import io.github.mcauzzi.cinemanager.security.BiometricGate
import io.github.mcauzzi.cinemanager.security.DeviceKeyStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Stato e flusso dell'app (docs/scanner-dvd.md §11): abbinamento → scansione → scelta →
 * modulo → esito, più impostazioni, aggiornamenti obbligatori e sblocco biometrico.
 */
class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val store = PairingStore(app)
    private val http = CineManagerApi.defaultClient()

    private var pairing: Pairing? = null
    private var api: CineManagerApi? = null
    private var requireBiometric = false
    private var fields: List<FormField>? = null

    /** Operazione da ripetere dopo lo sblocco biometrico. */
    private var pendingRetry: (() -> Unit)? = null
    private var backgroundSince: Long? = null
    private var current: Job? = null

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val appVersionCode = BuildConfig.VERSION_CODE

    init {
        viewModelScope.launch {
            val s = store.load()
            requireBiometric = s.requireBiometric
            val p = s.pairing
            if (p == null || !withContext(Dispatchers.IO) { DeviceKeyStore.exists() }) {
                // Dati incompleti (chiave senza abbinamento o viceversa): si riparte da zero.
                forgetLocal()
                toPairing()
                return@launch
            }
            // Il Keystore può lanciare (servizio non disponibile, voce illeggibile): mai sul main
            // thread e mai senza gestione, altrimenti l'app si chiude a ogni apertura.
            val key = withContext(Dispatchers.IO) { runCatching { DeviceKeyStore.load() } }
            val k = key.getOrNull()
            if (k == null) {
                // Abbinamento e chiave restano: se l'errore era passeggero, alla prossima apertura
                // funziona di nuovo; "Abbina di nuovo" crea comunque una chiave nuova.
                val reason = key.exceptionOrNull()
                    ?.let { text(R.string.repair_keystore, it.message ?: it.javaClass.simpleName) }
                    ?: text(R.string.repair_missing)
                screen(Screen.Repair(reason, serverStillActive = true))
                return@launch
            }
            usePairing(p, k)
            screen(Screen.Scan())
            if (requireBiometric) lock() else afterUnlock()
        }
    }

    // ------------------------------------------------------------------ stato

    private fun screen(s: Screen) = _state.update { it.copy(screen = s) }

    /** Modifica la schermata attuale solo se è di tipo [S]. */
    private inline fun <reified S : Screen> updateScreen(f: (S) -> Screen) {
        val s = _state.value.screen as? S ?: return
        screen(f(s))
    }

    /** Operazione ripetuta dal pulsante "Riprova" del messaggio. */
    private var messageRetry: (() -> Unit)? = null

    private fun message(t: UiText?, retry: (() -> Unit)? = null) {
        messageRetry = retry
        _state.update { it.copy(message = t, messageRetryable = retry != null) }
    }

    /** Messaggio chiuso; [retry] = premuto "Riprova". */
    fun messageShown(retry: Boolean = false) {
        val r = messageRetry
        message(null)
        if (retry) r?.invoke()
    }

    private fun usePairing(p: Pairing, key: DeviceKey) {
        pairing = p
        api = CineManagerApi(ServerUrls.trusted(p.apiBase), http, DeviceCredentials(p.deviceId, key), appVersionCode)
        fields = null
    }

    private fun defaultDeviceName(): String =
        listOf(Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, Build.MODEL)
            .distinct().joinToString(" ").take(100)

    private fun clearSession() {
        pairing = null
        api = null
        fields = null
    }

    private fun toPairing(error: UiText? = null) {
        clearSession()
        _state.update { it.copy(screen = pairingScreen(defaultDeviceName(), error), settings = null, update = null, locked = false) }
    }

    private fun pairingScreen(name: String, error: UiText? = null) = Screen.Pairing(
        name, error = error,
        requireBiometric = requireBiometric, biometricAvailable = BiometricGate.available(getApplication()),
    )

    /**
     * Senza blocco schermo sicuro una chiave con autenticazione non si può creare: l'opzione
     * dell'impronta si spegne, altrimenti ogni nuovo abbinamento fallirebbe.
     */
    private suspend fun resetBiometricIfUnavailable() {
        if (requireBiometric && !BiometricGate.available(getApplication())) {
            store.setRequireBiometric(false)
            requireBiometric = false
        }
    }

    /**
     * Esegue [block] con indicatore di attesa e gestione comune degli errori. Lo sblocco
     * biometrico ripete l'operazione; revoca, chiave invalidata e 426 cambiano schermata.
     */
    private fun launch(onError: suspend (Throwable) -> Boolean = { false }, block: suspend () -> Unit) {
        current?.cancel()
        current = viewModelScope.launch {
            _state.update { it.copy(busy = true) }
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (!onError(e)) handle(e) { launch(onError, block) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    private suspend fun handle(e: Throwable, retry: () -> Unit) {
        when {
            ErrorPolicy.needsUnlock(e) -> {
                pendingRetry = retry
                _state.update { it.copy(authPending = true) }
            }
            // Chiave invalidata o sparita: non può più firmare, nemmeno DELETE /api/app/me.
            ErrorPolicy.forgetsPairing(e) -> forget(ErrorText.of(e), serverStillActive = true)
            e is ApiException.DeviceRevoked -> forget(text(R.string.repair_revoked), serverStillActive = false)
            e is ApiException.UpgradeRequired ->
                screen(Screen.UpdateRequired(api?.server?.apkUrl, e.minSupportedCode))
            e is ApiException.OwnerInactive -> screen(Screen.OwnerInactive(api?.server?.siteRoot))
            else -> message(ErrorText.of(e), retry.takeIf { ErrorPolicy.retryable(e) })
        }
    }

    /**
     * Abbinamento non più valido: si cancellano chiave e dati locali. [serverStillActive]: il
     * dispositivo non è stato revocato sul server, va revocato dal sito.
     */
    private suspend fun forget(reason: UiText, serverStillActive: Boolean) {
        forgetLocal()
        clearSession()
        _state.update { it.copy(screen = Screen.Repair(reason, serverStillActive), settings = null, update = null) }
    }

    // ------------------------------------------------------------------ sblocco biometrico

    private fun lock() = _state.update { it.copy(locked = true, authPending = true) }

    fun requestUnlock() = _state.update { it.copy(authPending = true) }

    fun onAuthResult(success: Boolean) {
        val wasLocked = _state.value.locked
        _state.update { it.copy(authPending = false) }
        if (!success) {
            pendingRetry = null
            if (!wasLocked) message(text(R.string.error_auth_required))
            return
        }
        _state.update { it.copy(locked = false) }
        val retry = pendingRetry
        pendingRetry = null
        when {
            retry != null -> retry()
            wasLocked -> afterUnlock()
        }
    }

    fun onBackground() { backgroundSince = SystemClock.elapsedRealtime() }

    /** Di nuovo in primo piano dopo la finestra di 10 minuti: si richiede lo sblocco. */
    fun onForeground() {
        val since = backgroundSince ?: return
        backgroundSince = null
        if (requireBiometric && pairing != null &&
            SystemClock.elapsedRealtime() - since >= DeviceKeyStore.AUTH_VALIDITY_SECONDS * 1000L
        ) lock()
    }

    /** Dopo l'apertura (e lo sblocco): verifica dell'abbinamento e della versione. */
    private fun afterUnlock() {
        checkVersion()
        launch(onError = { e -> e is ApiException.Network }) { api?.me() }
    }

    private fun checkVersion() {
        val a = api ?: return
        viewModelScope.launch {
            val v = runCatching { a.appVersion() }.getOrNull() ?: return@launch
            when (v.stateFor(appVersionCode)) {
                UpdateState.UPDATE_REQUIRED -> screen(Screen.UpdateRequired(a.server.apkUrl, v.minSupportedCode))
                UpdateState.UPDATE_AVAILABLE -> _state.update { it.copy(update = v) }
                UpdateState.UP_TO_DATE -> _state.update { it.copy(update = null) }
            }
        }
    }

    // ------------------------------------------------------------------ abbinamento

    fun startPairing() {
        screen(pairingScreen((_state.value.screen as? Screen.Pairing)?.deviceName ?: defaultDeviceName()))
    }

    /**
     * "Chiedi impronta" scelta prima di abbinare: vale per la chiave che verrà creata. Un'eventuale
     * chiave rimasta da un abbinamento interrotto si cancella, perché ha l'impostazione vecchia.
     */
    fun setPairRequireBiometric(value: Boolean) {
        if (_state.value.screen !is Screen.Pairing || _state.value.busy) return
        viewModelScope.launch {
            store.setRequireBiometric(value)
            requireBiometric = value
            withContext(Dispatchers.IO) { DeviceKeyStore.delete() }
            updateScreen<Screen.Pairing> {
                it.copy(requireBiometric = value, biometricAvailable = BiometricGate.available(getApplication()), error = null)
            }
        }
    }

    fun onDeviceNameChange(name: String) = updateScreen<Screen.Pairing> { it.copy(deviceName = name.take(100), error = null) }
    fun onPairManualChange(text: String) = updateScreen<Screen.Pairing> { it.copy(manual = text, error = null) }
    fun setPairScanning(on: Boolean) = updateScreen<Screen.Pairing> { it.copy(scanning = on, error = null) }

    fun onPairingQr(raw: String) {
        val s = _state.value.screen as? Screen.Pairing ?: return
        if (_state.value.busy) return
        val name = s.deviceName.trim()
        if (name.isEmpty()) {
            screen(s.copy(scanning = false, error = text(R.string.pair_error_name)))
            return
        }
        when (val r = PairingQrParser.parse(raw, allowHttp = BuildConfig.ALLOW_HTTP)) {
            is PairingQrResult.Invalid -> screen(s.copy(scanning = false, error = ErrorText.of(r.reason)))
            is PairingQrResult.Valid -> {
                if (requireBiometric && !BiometricGate.available(getApplication())) {
                    // Impossibile creare una chiave con autenticazione senza blocco schermo.
                    screen(s.copy(scanning = false, error = text(R.string.pair_error_biometric_unavailable),
                        requireBiometric = true, biometricAvailable = false))
                    return
                }
                screen(s.copy(scanning = false, error = null))
                launch(onError = { e -> pairFailed(e) }) {
                    // Se lo sblocco biometrico interrompe l'abbinamento, al nuovo tentativo si
                    // riusa la chiave appena creata (senza chiedere di nuovo l'impronta).
                    val key = withContext(Dispatchers.IO) {
                        runCatching { DeviceKeyStore.load() }.getOrNull() ?: DeviceKeyStore.generate(requireBiometric)
                    }
                    val anon = CineManagerApi(r.qr.server, http, null, appVersionCode)
                    val res = anon.pair(r.qr.code, name, key)
                    val p = Pairing(r.qr.server.apiBase, res.deviceId, name, res.user.name)
                    store.savePairing(p)
                    usePairing(p, key)
                    _state.update { it.copy(screen = Screen.Scan(), message = text(R.string.pair_done, res.user.name)) }
                    checkVersion()
                }
            }
        }
    }

    /** Errori dell'abbinamento mostrati nella schermata (la chiave locale resta per il prossimo QR). */
    private suspend fun pairFailed(e: Throwable): Boolean {
        if (ErrorPolicy.needsUnlock(e)) return false
        // Solo una chiave inutilizzabile si butta; telefono bloccato o errore passeggero: si riprova.
        if (ErrorPolicy.forgetsPairing(e)) withContext(Dispatchers.IO) { DeviceKeyStore.delete() }
        val msg = when (e) {
            is ApiException, is KeyUnavailableException -> ErrorText.of(e)
            // Creazione della chiave non riuscita (es. impronta richiesta senza blocco schermo).
            else -> text(R.string.pair_error_keystore, e.message ?: e.javaClass.simpleName)
        }
        updateScreen<Screen.Pairing> { it.copy(scanning = false, error = msg) }
        return true
    }

    // ------------------------------------------------------------------ scansione

    fun onManualEanChange(v: String) = updateScreen<Screen.Scan> { it.copy(manualEan = v.filter(Char::isDigit).take(14)) }

    fun submitManualEan() {
        val s = _state.value.screen as? Screen.Scan ?: return
        val ean = Ean.normalize(s.manualEan)
        if (ean == null) {
            message(text(R.string.scan_invalid_ean))
            return
        }
        lookup(ean)
    }

    fun onBarcode(raw: String) {
        if (_state.value.busy || _state.value.screen !is Screen.Scan) return
        val ean = Ean.normalize(raw) ?: return
        lookup(ean)
    }

    private fun lookup(ean: String) {
        val a = api ?: return
        launch {
            val l = a.lookup(ean)
            loadFields(a)
            when {
                l.candidates.size > 1 -> screen(chooseFor(ean, l))
                l.candidates.size == 1 || l.draft.isNotEmpty() -> openForm(a, sourceFrom(ean, l, null), l.draft)
                else -> {
                    screen(chooseFor(ean, l))
                    message(text(if (l.productName == null) R.string.choose_unknown_ean else R.string.choose_no_match))
                }
            }
            if (!l.tmdbAvailable) message(text(R.string.choose_tmdb_unavailable))
        }
    }

    private fun chooseFor(ean: String, l: LookupResponse) =
        Screen.Choose(ean, l, l.candidates, query = (l.draft["title"] as? JsonPrimitive)?.content ?: l.productName.orEmpty())

    private fun sourceFrom(ean: String, l: LookupResponse, choose: Screen.Choose?) =
        DraftSource(ean, l.tmdbId, l.posterPath, l.posterUrl, l.possibleDuplicates, choose)

    private suspend fun loadFields(a: CineManagerApi): List<FormField> =
        fields ?: MovieForm.formFields(a.fields()).also { fields = it }

    // ------------------------------------------------------------------ scelta

    fun onQueryChange(q: String) = updateScreen<Screen.Choose> { it.copy(query = q.take(200)) }
    fun onYearChange(y: String) = updateScreen<Screen.Choose> { it.copy(year = y.filter(Char::isDigit).take(4)) }

    fun search() {
        val s = _state.value.screen as? Screen.Choose ?: return
        val a = api ?: return
        val q = s.query.trim()
        if (q.isEmpty()) return
        val year = s.year.toIntOrNull()?.takeIf { it in 1870..2200 }
        launch {
            val c = a.search(q, year)
            // Sullo stato attuale: titolo e anno possono essere cambiati durante la ricerca.
            updateScreen<Screen.Choose> { it.copy(candidates = c, searched = true) }
            if (c.isEmpty()) message(text(R.string.choose_no_results))
        }
    }

    fun choose(c: Candidate) {
        val s = _state.value.screen as? Screen.Choose ?: return
        val a = api ?: return
        launch {
            if (c.tmdbId == s.lookup.tmdbId) return@launch openForm(a, sourceFrom(s.ean, s.lookup, s), s.lookup.draft)
            val d = a.tmdb(c.tmdbId)
            val dups = (s.lookup.possibleDuplicates + d.possibleDuplicates).distinctBy(DuplicateRef::id)
            openForm(a, DraftSource(s.ean, d.tmdbId, d.posterPath, d.posterUrl, dups, s), d.draft)
        }
    }

    /** Senza TMDb: modulo con la sola bozza del nome prodotto (o vuoto). */
    fun fillManually() {
        val s = _state.value.screen as? Screen.Choose ?: return
        val a = api ?: return
        val draft = s.lookup.draft.takeIf { it.isNotEmpty() }
            ?: JsonObject(mapOf(MovieForm.TITLE to JsonPrimitive(s.query.ifBlank { s.lookup.productName.orEmpty() })))
        launch { openForm(a, DraftSource(s.ean, null, null, null, s.lookup.possibleDuplicates, s), draft) }
    }

    // ------------------------------------------------------------------ modulo

    private suspend fun openForm(a: CineManagerApi, source: DraftSource, draft: JsonObject) {
        val f = loadFields(a)
        screen(Screen.Form(source, f, MovieForm.initialValues(f, draft), MovieForm.passthrough(f, draft)))
    }

    fun onFieldChange(name: String, value: FieldValue) =
        updateScreen<Screen.Form> { it.copy(values = it.values + (name to value), errors = it.errors - name) }

    fun submit() {
        val a = api ?: return
        val form = _state.value.screen as? Screen.Form ?: return
        val errors = MovieForm.validate(form.fields, form.values)
        if (errors.isNotEmpty()) {
            screen(form.copy(errors = errors, generalError = text(R.string.form_fix_errors)))
            return
        }
        val movie = MovieForm.toMovieJson(form.fields, form.values, form.passthrough)
        send(a, NewMovieRequest(form.source.ean, form.source.tmdbId, form.source.posterPath, movie), form)
    }

    fun confirmDuplicate() {
        val a = api ?: return
        val r = (_state.value.screen as? Screen.Result)?.outcome as? Outcome.PossibleDuplicate ?: return
        send(a, r.request.copy(confirmDuplicate = true), r.form)
    }

    private fun send(a: CineManagerApi, request: NewMovieRequest, form: Screen.Form) {
        val title = (request.movie[MovieForm.TITLE] as? JsonPrimitive)?.content.orEmpty()
        launch(onError = onError@{ e ->
            if (e !is ApiException.Validation) return@onError false
            screen(form.copy(errors = e.errors.mapValues { it.value.joinToString(" ") },
                generalError = e.detail?.let(UiText::Raw) ?: text(R.string.form_server_errors)))
            true
        }) {
            val outcome = when (val r = a.createMovie(request)) {
                // TODO: annullare dall'app un arrivo appena inviato (oggi correzione ed eliminazione
                // sono solo nel pannello ARRIVI del sito: PATCH/DELETE /api/movies/{id}).
                is CreateMovieResult.Created -> Outcome.Added(r.id, title)
                is CreateMovieResult.EanExists -> Outcome.EanExists(r.title)
                is CreateMovieResult.PossibleDuplicate -> Outcome.PossibleDuplicate(r.candidates, request, form)
            }
            screen(Screen.Result(outcome))
        }
    }

    fun backToForm() {
        val r = (_state.value.screen as? Screen.Result)?.outcome as? Outcome.PossibleDuplicate ?: return
        screen(r.form)
    }

    // ------------------------------------------------------------------ navigazione

    fun scanNext() = screen(Screen.Scan())

    fun apkUrl(): String? = api?.server?.apkUrl

    /** Indietro; false se non c'è nulla da chiudere (l'Activity esce). */
    fun back(): Boolean {
        val st = _state.value
        if (st.settings != null) {
            closeSettings(); return true
        }
        current?.cancel()
        when (val s = st.screen) {
            is Screen.Pairing -> if (s.scanning) setPairScanning(false) else return false
            is Screen.Choose -> scanNext()
            is Screen.Form -> s.source.choose?.let(::screen) ?: scanNext()
            is Screen.Result -> scanNext()
            else -> return false
        }
        return true
    }

    // ------------------------------------------------------------------ impostazioni

    fun openSettings() {
        val p = pairing ?: return
        val urls = ServerUrls.trusted(p.apiBase)
        _state.update {
            it.copy(settings = SettingsInfo(
                server = urls.host, siteUrl = urls.siteRoot, userName = p.userName, deviceName = p.deviceName,
                requireBiometric = requireBiometric, biometricAvailable = BiometricGate.available(getApplication()),
                appVersion = BuildConfig.VERSION_NAME,
            ))
        }
    }

    fun closeSettings() = _state.update { it.copy(settings = null) }

    /**
     * Cambiare l'opzione dell'impronta crea una chiave nuova: si scollega il dispositivo e si
     * rifà l'abbinamento (§4.2). L'interfaccia chiede conferma prima.
     */
    fun setRequireBiometric(value: Boolean) {
        launch {
            val revoked = unpairRemote(force = true)
            store.setRequireBiometric(value)
            requireBiometric = value
            forgetLocal()
            // §4.2: se la revoca non è riuscita il vecchio dispositivo resta attivo sul server.
            toPairing(text(if (revoked) R.string.settings_biometric_repair_done else R.string.settings_biometric_repair_done_offline))
        }
    }

    /**
     * "Scollega": prima `DELETE /api/app/me`, poi la chiave locale (§4.2). Se la revoca non
     * riesce (rete, 401 persistente, 403, 426, 5xx…) si propone di scollegare solo il telefono;
     * fa eccezione lo sblocco richiesto, che apre il prompt e ripete.
     */
    fun unpair(force: Boolean) {
        launch(onError = onError@{ e ->
            if (force || !ErrorPolicy.offerLocalUnpair(e)) return@onError false
            _state.update { it.copy(unpairFailure = ErrorText.of(e)) }
            true
        }) {
            val revoked = unpairRemote(force)
            forgetLocal()
            toPairing(text(if (revoked) R.string.settings_unpaired else R.string.settings_unpaired_offline))
        }
    }

    fun dismissUnpairFailure() = _state.update { it.copy(unpairFailure = null) }

    /**
     * `DELETE /api/app/me`. True se il dispositivo risulta revocato sul server; con [force] gli
     * errori (tranne lo sblocco richiesto) danno false invece di propagarsi.
     */
    private suspend fun unpairRemote(force: Boolean): Boolean {
        val a = api ?: return false
        return try {
            a.unpair()
            true
        } catch (e: ApiException.DeviceRevoked) {
            true // già revocato: va bene
        } catch (e: ApiException) {
            if (!force) throw e
            false
        } catch (e: KeyUnavailableException) {
            if (!force || ErrorPolicy.needsUnlock(e)) throw e
            false
        }
    }

    private suspend fun forgetLocal() {
        withContext(Dispatchers.IO) { DeviceKeyStore.delete() }
        store.clearPairing()
        resetBiometricIfUnavailable()
        dismissUnpairFailure()
    }

    fun retryAfterOwnerInactive() {
        screen(Screen.Scan())
        afterUnlock()
    }
}

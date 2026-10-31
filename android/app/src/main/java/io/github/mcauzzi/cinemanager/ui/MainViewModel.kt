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
                withContext(Dispatchers.IO) { DeviceKeyStore.delete() }
                if (p != null) store.clearPairing()
                toPairing()
                return@launch
            }
            usePairing(p)
            screen(Screen.Scan())
            if (requireBiometric) lock() else afterUnlock()
        }
    }

    // ------------------------------------------------------------------ stato

    private fun screen(s: Screen) = _state.update { it.copy(screen = s) }

    private fun message(t: UiText?) = _state.update { it.copy(message = t) }

    fun messageShown() = message(null)

    private fun usePairing(p: Pairing) {
        pairing = p
        val key = DeviceKeyStore.load()
        api = CineManagerApi(ServerUrls.trusted(p.apiBase), http, key?.let { DeviceCredentials(p.deviceId, it) }, appVersionCode)
        fields = null
    }

    private fun defaultDeviceName(): String =
        listOf(Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, Build.MODEL)
            .distinct().joinToString(" ").take(100)

    private fun toPairing(error: UiText? = null) {
        pairing = null
        api = null
        fields = null
        _state.update { it.copy(screen = Screen.Pairing(defaultDeviceName(), error = error), settings = null, update = null, locked = false) }
    }

    /**
     * Esegue [block] con indicatore di attesa e gestione comune degli errori. Lo sblocco
     * biometrico ripete l'operazione; revoca, chiave invalidata e 426 cambiano schermata.
     */
    private fun launch(onError: (Throwable) -> Boolean = { false }, block: suspend () -> Unit) {
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
            e is KeyUnavailableException && e.kind == KeyUnavailableException.Kind.AUTHENTICATION_REQUIRED -> {
                pendingRetry = retry
                _state.update { it.copy(authPending = true) }
            }
            e is KeyUnavailableException && e.kind != KeyUnavailableException.Kind.DEVICE_LOCKED -> forget(ErrorText.of(e))
            e is ApiException.DeviceRevoked -> forget(text(R.string.repair_revoked))
            e is ApiException.UpgradeRequired ->
                screen(Screen.UpdateRequired(api?.server?.apkUrl, e.minSupportedCode))
            e is ApiException.OwnerInactive -> screen(Screen.OwnerInactive(api?.server?.siteRoot))
            else -> message(ErrorText.of(e))
        }
    }

    /** Abbinamento non più valido: si cancellano chiave e dati locali. */
    private suspend fun forget(reason: UiText) {
        withContext(Dispatchers.IO) { DeviceKeyStore.delete() }
        store.clearPairing()
        pairing = null
        api = null
        _state.update { it.copy(screen = Screen.Repair(reason), settings = null, update = null) }
    }

    // ------------------------------------------------------------------ sblocco biometrico

    private fun lock() {
        _state.update { it.copy(locked = true, authPending = true) }
    }

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

    fun onBackground() {
        backgroundSince = SystemClock.elapsedRealtime()
    }

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
        val s = _state.value.screen
        val name = (s as? Screen.Pairing)?.deviceName ?: defaultDeviceName()
        screen(Screen.Pairing(name))
    }

    fun onDeviceNameChange(name: String) = updatePairing { it.copy(deviceName = name.take(100), error = null) }
    fun onPairManualChange(text: String) = updatePairing { it.copy(manual = text, error = null) }
    fun setPairScanning(on: Boolean) = updatePairing { it.copy(scanning = on, error = null) }

    private fun updatePairing(f: (Screen.Pairing) -> Screen.Pairing) {
        val s = _state.value.screen as? Screen.Pairing ?: return
        screen(f(s))
    }

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
                screen(s.copy(scanning = false, error = null))
                launch(onError = { e -> pairFailed(e) }) {
                    // Se lo sblocco biometrico interrompe l'abbinamento, al nuovo tentativo si
                    // riusa la chiave appena creata (senza chiedere di nuovo l'impronta).
                    val key = withContext(Dispatchers.IO) {
                        DeviceKeyStore.load() ?: DeviceKeyStore.generate(requireBiometric)
                    }
                    val anon = CineManagerApi(r.qr.server, http, null, appVersionCode)
                    val res = anon.pair(r.qr.code, name, key)
                    val p = Pairing(r.qr.server.apiBase, res.deviceId, name, res.user.name)
                    store.savePairing(p)
                    usePairing(p)
                    _state.update { it.copy(screen = Screen.Scan(), message = text(R.string.pair_done, res.user.name)) }
                    checkVersion()
                }
            }
        }
    }

    /** Errori dell'abbinamento mostrati nella schermata (la chiave locale resta per il prossimo QR). */
    private fun pairFailed(e: Throwable): Boolean {
        if (e is KeyUnavailableException && e.kind == KeyUnavailableException.Kind.AUTHENTICATION_REQUIRED) return false
        if (e is KeyUnavailableException) DeviceKeyStore.delete()
        val msg = when (e) {
            is ApiException, is KeyUnavailableException -> ErrorText.of(e)
            // Creazione della chiave non riuscita (es. impronta richiesta senza blocco schermo).
            else -> text(R.string.pair_error_keystore, e.message ?: e.javaClass.simpleName)
        }
        updatePairing { it.copy(scanning = false, error = msg) }
        return true
    }

    // ------------------------------------------------------------------ scansione

    fun onManualEanChange(v: String) {
        val s = _state.value.screen as? Screen.Scan ?: return
        screen(s.copy(manualEan = v.filter { it.isDigit() }.take(14)))
    }

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
                l.candidates.size == 1 || l.draft.isNotEmpty() -> openForm(sourceFrom(ean, l, null), l.draft)
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

    fun onQueryChange(q: String) = updateChoose { it.copy(query = q.take(200)) }
    fun onYearChange(y: String) = updateChoose { it.copy(year = y.filter(Char::isDigit).take(4)) }

    private fun updateChoose(f: (Screen.Choose) -> Screen.Choose) {
        val s = _state.value.screen as? Screen.Choose ?: return
        screen(f(s))
    }

    fun search() {
        val s = _state.value.screen as? Screen.Choose ?: return
        val a = api ?: return
        val q = s.query.trim()
        if (q.isEmpty()) return
        val year = s.year.toIntOrNull()?.takeIf { it in 1870..2200 }
        launch {
            val c = a.search(q, year)
            screen(s.copy(candidates = c, searched = true))
            if (c.isEmpty()) message(text(R.string.choose_no_results))
        }
    }

    fun choose(c: Candidate) {
        val s = _state.value.screen as? Screen.Choose ?: return
        val a = api ?: return
        if (c.tmdbId == s.lookup.tmdbId) {
            launch { loadFields(a); openForm(sourceFrom(s.ean, s.lookup, s), s.lookup.draft) }
            return
        }
        launch {
            val d = a.tmdb(c.tmdbId)
            loadFields(a)
            val dups = (s.lookup.possibleDuplicates + d.possibleDuplicates).distinctBy(DuplicateRef::id)
            openForm(DraftSource(s.ean, d.tmdbId, d.posterPath, d.posterUrl, dups, s), d.draft)
        }
    }

    /** Senza TMDb: modulo con la sola bozza del nome prodotto (o vuoto). */
    fun fillManually() {
        val s = _state.value.screen as? Screen.Choose ?: return
        val a = api ?: return
        launch {
            loadFields(a)
            val draft = s.lookup.draft.takeIf { it.isNotEmpty() }
                ?: JsonObject(mapOf(MovieForm.TITLE to JsonPrimitive(s.query.ifBlank { s.lookup.productName.orEmpty() })))
            openForm(DraftSource(s.ean, null, null, null, s.lookup.possibleDuplicates, s), draft)
        }
    }

    // ------------------------------------------------------------------ modulo

    private fun openForm(source: DraftSource, draft: JsonObject) {
        val f = fields ?: return
        screen(Screen.Form(source, f, MovieForm.initialValues(f, draft), MovieForm.passthrough(f, draft)))
    }

    fun onFieldChange(name: String, value: FieldValue) {
        val s = _state.value.screen as? Screen.Form ?: return
        screen(s.copy(values = s.values + (name to value), errors = s.errors - name))
    }

    fun submit(confirmDuplicate: Boolean = false, retryRequest: NewMovieRequest? = null, retryForm: Screen.Form? = null) {
        val a = api ?: return
        val form = retryForm ?: _state.value.screen as? Screen.Form ?: return
        val request = retryRequest?.copy(confirmDuplicate = confirmDuplicate) ?: run {
            val errors = MovieForm.validate(form.fields, form.values)
            if (errors.isNotEmpty()) {
                screen(form.copy(errors = errors, generalError = text(R.string.form_fix_errors)))
                return
            }
            NewMovieRequest(
                ean = form.source.ean,
                tmdbId = form.source.tmdbId,
                posterPath = form.source.posterPath,
                movie = MovieForm.toMovieJson(form.fields, form.values, form.passthrough),
                confirmDuplicate = confirmDuplicate,
            )
        }
        val title = (request.movie[MovieForm.TITLE] as? JsonPrimitive)?.content.orEmpty()
        launch(onError = { e ->
            if (e is ApiException.Validation) {
                screen(form.copy(errors = e.errors.mapValues { it.value.joinToString(" ") },
                    generalError = e.detail?.let(UiText::Raw) ?: text(R.string.form_server_errors)))
                true
            } else {
                false
            }
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

    fun confirmDuplicate() {
        val r = (_state.value.screen as? Screen.Result)?.outcome as? Outcome.PossibleDuplicate ?: return
        submit(confirmDuplicate = true, retryRequest = r.request, retryForm = r.form)
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
            unpairRemote(force = true)
            store.setRequireBiometric(value)
            requireBiometric = value
            forgetLocal()
            toPairing(text(R.string.settings_biometric_repair_done))
        }
    }

    /** "Scollega": prima `DELETE /api/app/me`, poi la chiave locale (§4.2). */
    fun unpair(force: Boolean) {
        launch(onError = { e ->
            if (e is ApiException.Network && !force) {
                _unpairOffline.value = true
                true
            } else {
                false
            }
        }) {
            unpairRemote(force)
            forgetLocal()
            toPairing(text(if (force) R.string.settings_unpaired_offline else R.string.settings_unpaired))
        }
    }

    private val _unpairOffline = MutableStateFlow(false)

    /** Il server non risponde: chiedere se scollegare solo il telefono. */
    val unpairOffline: StateFlow<Boolean> = _unpairOffline.asStateFlow()

    fun dismissUnpairOffline() {
        _unpairOffline.value = false
    }

    private suspend fun unpairRemote(force: Boolean) {
        try {
            api?.unpair()
        } catch (e: ApiException.DeviceRevoked) {
            // già revocato: va bene
        } catch (e: ApiException) {
            if (!force) throw e
        } catch (e: KeyUnavailableException) {
            if (!force || e.kind == KeyUnavailableException.Kind.AUTHENTICATION_REQUIRED) throw e
        }
    }

    private suspend fun forgetLocal() {
        withContext(Dispatchers.IO) { DeviceKeyStore.delete() }
        store.clearPairing()
        _unpairOffline.value = false
    }

    fun retryAfterOwnerInactive() {
        screen(Screen.Scan())
        afterUnlock()
    }
}

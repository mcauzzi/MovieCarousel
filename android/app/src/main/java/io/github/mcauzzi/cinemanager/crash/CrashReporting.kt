package io.github.mcauzzi.cinemanager.crash

import android.app.ActivityManager
import android.app.Application
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.os.Process
import android.util.Log
import io.github.mcauzzi.cinemanager.BuildConfig
import io.github.mcauzzi.cinemanager.core.api.CineManagerApi
import io.github.mcauzzi.cinemanager.core.crash.CrashEnvironment
import io.github.mcauzzi.cinemanager.core.crash.CrashQueue
import io.github.mcauzzi.cinemanager.core.crash.CrashReport
import io.github.mcauzzi.cinemanager.core.crash.CrashUploader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import java.io.File
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.system.exitProcess

/**
 * Segnalazione dei crash all'API (`POST /api/app/crash`): le eccezioni non gestite vengono salvate
 * su file nel gestore di default; al riavvio si aggiungono le uscite che il processo non può
 * intercettare (ANR, crash nativi) da [ApplicationExitInfo]. L'invio avviene con una richiesta
 * firmata quando la chiave è utilizzabile (dopo l'eventuale sblocco o dopo l'abbinamento).
 */
object CrashReporting {
    private const val TAG = "CrashReporting"
    private const val PREFS = "crash_reporting"
    private const val LAST_EXIT = "last_exit_timestamp"

    private lateinit var queue: CrashQueue
    private lateinit var env: CrashEnvironment
    private val handling = AtomicBoolean(false)
    private val uploading = Mutex()

    fun install(app: Application) {
        env = CrashEnvironment(
            appVersionCode = BuildConfig.VERSION_CODE,
            appVersion = BuildConfig.VERSION_NAME,
            device = "${Build.MANUFACTURER} ${Build.MODEL}",
            android = "${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})",
        )
        queue = CrashQueue(File(app.filesDir, "crash-reports"))

        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            // Una sola volta: un errore durante il salvataggio non deve ricorsivamente richiamarci.
            if (handling.compareAndSet(false, true)) {
                queue.save(CrashReport.fromThrowable(e, t.name, Instant.now().toString(), env))
            }
            // Il gestore di Android mostra il dialogo e chiude il processo come prima.
            previous?.uncaughtException(t, e) ?: run {
                Process.killProcess(Process.myPid())
                exitProcess(10)
            }
        }

        thread(name = "crash-exit-info", isDaemon = true) {
            try {
                collectExitInfo(app)
            } catch (e: Exception) {
                Log.w(TAG, "ApplicationExitInfo non letto", e)
            }
        }
    }

    /** Uscite precedenti che il gestore Java non vede. I crash Java li ha già salvati [install]. */
    private fun collectExitInfo(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val last = prefs.getLong(LAST_EXIT, 0)
        val infos = context.getSystemService(ActivityManager::class.java)
            .getHistoricalProcessExitReasons(null, 0, 10)
            .filter { it.timestamp > last }
        if (infos.isEmpty()) return
        for (info in infos.sortedBy { it.timestamp }) {
            val kind = when (info.reason) {
                ApplicationExitInfo.REASON_ANR -> "anr"
                ApplicationExitInfo.REASON_CRASH_NATIVE -> "native"
                else -> continue
            }
            // Solo per gli ANR la traccia è testo (dump dei thread, "main" in testa); per i crash
            // nativi è un tombstone binario: resta la descrizione.
            val trace = if (kind == "anr") {
                runCatching {
                    info.traceInputStream?.bufferedReader()?.use { r ->
                        val buf = CharArray(CrashReport.STACK_MAX + 1)
                        val n = r.read(buf).coerceAtLeast(0)
                        CrashReport.truncate(String(buf, 0, n), CrashReport.STACK_MAX)
                    }
                }.getOrNull()
            } else {
                null
            }
            queue.save(
                CrashReport(
                    kind = kind,
                    occurredAt = Instant.ofEpochMilli(info.timestamp).toString(),
                    // ApplicationExitInfo non dice la versione: è quella installata ora.
                    appVersionCode = env.appVersionCode,
                    appVersion = env.appVersion,
                    device = env.device,
                    android = env.android,
                    exception = if (kind == "anr") "ANR" else "NativeCrash",
                    message = info.description?.let { CrashReport.truncate(it, CrashReport.MESSAGE_MAX) },
                    stackTrace = trace,
                ),
            )
        }
        prefs.edit().putLong(LAST_EXIT, infos.maxOf { it.timestamp }).apply()
    }

    /**
     * Invia la coda con [api]. Non lancia mai e non mostra nulla: chi segnala un crash non deve
     * vedere errori. Un invio già in corso fa saltare quelli successivi.
     */
    suspend fun upload(api: CineManagerApi) {
        if (!::queue.isInitialized || !uploading.tryLock()) return
        try {
            val sent = CrashUploader(queue) { api.sendCrashReports(it) }.upload()
            if (sent > 0) Log.i(TAG, "Segnalazioni di crash inviate: $sent")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Invio delle segnalazioni di crash non riuscito", e)
        } finally {
            uploading.unlock()
        }
    }
}

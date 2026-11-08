package io.github.mcauzzi.cinemanager.core.crash

import kotlinx.serialization.json.Json
import java.io.File
import java.util.UUID

/**
 * Segnalazioni in attesa di invio, un file JSON ciascuna in [dir]. [save] è sincrono e non lancia
 * mai: gira nel gestore delle eccezioni non gestite, subito prima che il processo muoia.
 * Restano al più [maxFiles] segnalazioni (le più vecchie vengono scartate) e nessuna più vecchia
 * di [maxAgeMillis]: un crash avvenuto prima dell'abbinamento non aspetta per sempre.
 */
class CrashQueue(
    private val dir: File,
    private val maxFiles: Int = 20,
    private val maxAgeMillis: Long = 30L * 24 * 3600 * 1000,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    class Entry(val file: File, val report: CrashReport)

    fun save(report: CrashReport): Boolean = try {
        dir.mkdirs()
        // Il timestamp nel nome (a larghezza fissa) dà ordine e scadenza senza leggere il file.
        val name = "crash-${clock().toString().padStart(15, '0')}-${UUID.randomUUID().toString().take(8)}.json"
        val tmp = File(dir, "$name.tmp")
        tmp.writeText(JSON.encodeToString(CrashReport.serializer(), report))
        // Rinomina atomica: un file a metà (processo ucciso durante la scrittura) resta .tmp.
        tmp.renameTo(File(dir, name)).also { prune() }
    } catch (_: Throwable) {
        false
    }

    /** Segnalazioni da inviare, dalla più vecchia; quelle illeggibili o scadute vengono cancellate. */
    fun pending(): List<Entry> {
        prune()
        return files().mapNotNull { f ->
            runCatching { Entry(f, JSON.decodeFromString(CrashReport.serializer(), f.readText())) }
                .getOrElse { f.delete(); null }
        }
    }

    fun delete(entries: Collection<Entry>) = entries.forEach { it.file.delete() }

    private fun files(): List<File> =
        dir.listFiles { f -> f.isFile && f.name.startsWith("crash-") && f.name.endsWith(".json") }
            ?.sortedBy { it.name }.orEmpty()

    private fun prune() {
        val now = clock()
        dir.listFiles { f -> f.name.endsWith(".tmp") && now - f.lastModified() > 60_000 }?.forEach { it.delete() }
        val all = files()
        val tooOld = all.filter { f ->
            f.name.split('-').getOrNull(1)?.toLongOrNull()?.let { now - it > maxAgeMillis } ?: true
        }.toSet()
        tooOld.forEach { it.delete() }
        val left = all - tooOld
        if (left.size > maxFiles) left.take(left.size - maxFiles).forEach { it.delete() }
    }

    private companion object {
        val JSON = Json { ignoreUnknownKeys = true; explicitNulls = false }
    }
}

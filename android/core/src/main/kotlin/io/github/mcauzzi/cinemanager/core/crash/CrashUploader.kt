package io.github.mcauzzi.cinemanager.core.crash

import io.github.mcauzzi.cinemanager.core.api.ApiException
import kotlinx.serialization.json.Json

/**
 * Invia la coda a lotti (al più [maxBatch] segnalazioni e [maxBatchBytes] di JSON) con [send],
 * cancellando i file solo dopo la conferma. Un lotto rifiutato come non valido (400/413) viene
 * scartato, altrimenti verrebbe rinviato per sempre; rete, 5xx, 429, 426, chiave non disponibile
 * e simili lasciano la coda intatta per il prossimo avvio.
 */
class CrashUploader(
    private val queue: CrashQueue,
    private val maxBatch: Int = 10,
    private val maxBatchBytes: Int = 200 * 1024,
    private val send: suspend (List<CrashReport>) -> Unit,
) {
    /** Numero di segnalazioni confermate dal server. Gli errori dell'API fermano l'invio senza lanciare. */
    suspend fun upload(): Int {
        var sent = 0
        val pending = ArrayDeque(queue.pending())
        while (pending.isNotEmpty()) {
            val batch = mutableListOf<CrashQueue.Entry>()
            var bytes = 0
            while (pending.isNotEmpty() && batch.size < maxBatch) {
                // Byte UTF-8, non caratteri: il limite del server (256 KB) è sui byte del corpo.
                val size = JSON.encodeToString(CrashReport.serializer(), pending.first().report).encodeToByteArray().size
                if (batch.isNotEmpty() && bytes + size > maxBatchBytes) break
                batch += pending.removeFirst()
                bytes += size
            }
            try {
                send(batch.map { it.report })
                sent += batch.size
            } catch (e: ApiException) {
                if (e !is ApiException.Validation && e !is ApiException.TooLarge) return sent
            }
            queue.delete(batch)
        }
        return sent
    }

    private companion object {
        val JSON = Json { explicitNulls = false }
    }
}

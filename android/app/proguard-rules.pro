# Modelli JSON (kotlinx.serialization): la libreria porta già regole per i serializer generati;
# queste le rendono esplicite per i nostri pacchetti.
-keepattributes *Annotation*, InnerClasses
-keep,includedescriptorclasses class io.github.mcauzzi.cinemanager.**$$serializer { *; }
-keepclassmembers class io.github.mcauzzi.cinemanager.** {
    *** Companion;
}
-keepclasseswithmembers class io.github.mcauzzi.cinemanager.** {
    kotlinx.serialization.KSerializer serializer(...);
}

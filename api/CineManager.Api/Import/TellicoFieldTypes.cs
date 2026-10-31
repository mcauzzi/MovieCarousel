using CineManager.Api.Data;

namespace CineManager.Api.Import;

/// <summary>Codici numerici e flag dei campi Tellico (§5, §10).</summary>
public static class TellicoFieldTypes
{
    public const int FlagAllowMultiple = 0x01;
    public const int FlagAllowGrouped = 0x02;
    public const int FlagNoEdit = 0x10;
    public const int FlagDerived = 0x20;

    /// <summary>
    /// 1 line, 2 para, 3 choice, 4 bool, 6 number, 7 url, 8 table, 10 image, 12 date, 14 rating;
    /// 11 o flag "derivato" (0x20) → dependent; ogni altro codice (es. 5, sola lettura) → line.
    /// </summary>
    public static string Map(string? code, int flags)
    {
        if ((flags & FlagDerived) != 0) return FieldTypes.Dependent;
        return code?.Trim() switch
        {
            "1" => FieldTypes.Line,
            "2" => FieldTypes.Para,
            "3" => FieldTypes.Choice,
            "4" => FieldTypes.Bool,
            "6" => FieldTypes.Number,
            "7" => FieldTypes.Url,
            "8" => FieldTypes.Table,
            "10" => FieldTypes.Image,
            "11" => FieldTypes.Dependent,
            "12" => FieldTypes.Date,
            "14" => FieldTypes.Rating,
            _ => FieldTypes.Line,
        };
    }
}

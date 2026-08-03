# Eclesiar Userscripts

Userscripty do [Eclesiar](https://eclesiar.com/) — pamięć kart w minigrze *Memory*
oraz pilnowanie presetów sprzętu pod teren bitwy.

**➡️ Strona z instrukcją instalacji: https://scripts.ecle.fun/**

## Minigra Memory

| Skrypt | Opis | Instalacja |
|---|---|---|
| [`eclesiar-memory-tracker-v3-sync.user.js`](eclesiar-memory-tracker-v3-sync.user.js) | Wersja zalecana — podgląd kart, synchronizacja między urządzeniami, podświetlanie par, rotacja eventów | [Zainstaluj](https://raw.githubusercontent.com/marsach/ecle/main/eclesiar-memory-tracker-v3-sync.user.js) |
| [`eclesiar-memory-tracker-v1.user.js`](eclesiar-memory-tracker-v1.user.js) | Wersja prosta — tylko lokalna pamięć kart, bez konfiguracji | [Zainstaluj](https://raw.githubusercontent.com/marsach/ecle/main/eclesiar-memory-tracker-v1.user.js) |

Zainstaluj **tylko jedną** wersję — obie używają tego samego magazynu `eclesiar_memory_cache`.

## Wojna

| Skrypt | Opis | Instalacja |
|---|---|---|
| [`eclesiar-terrain-preset-reminder.user.js`](eclesiar-terrain-preset-reminder.user.js) | Wykrywa teren bitwy i ostrzega, gdy aktywny preset sprzętu nie jest na Twojej allow-liście dla tego terenu | [Zainstaluj](https://raw.githubusercontent.com/marsach/ecle/main/eclesiar-terrain-preset-reminder.user.js) |

Działa niezależnie od Memory Trackera — można mieć oba naraz.

Wymagany [Tampermonkey](https://www.tampermonkey.net/) lub Violentmonkey.

Autorzy: morswin28, kmi3c

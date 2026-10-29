# Supabase-Teil der Rechnungs-App

- `functions/rechnungen/` – Cloud-Funktion (PDF, Versand, Korrektur, Abos, Erinnerungen)
- `migrations/` – Datenbank-Skripte, alle wiederholbar ausführbar

Jeder Push auf `main`, der diesen Ordner ändert, wird per GitHub Action automatisch in Supabase eingespielt.

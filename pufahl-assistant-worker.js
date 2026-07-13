/**
 * ═══════════════════════════════════════════════════════════════
 *  Autohaus Pufahl – KI-Assistent Backend (Cloudflare Worker)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Dieser Worker hält den Anthropic-API-Key sicher serverseitig und
 *  leitet Chat-Anfragen der Website an Claude weiter.
 *
 *  ── EINRICHTUNG ──────────────────────────────────────────────
 *  1. Worker anlegen:  npx wrangler deploy   (oder im Cloudflare-Dashboard)
 *  2. API-Key als Secret setzen (NIEMALS in den Code schreiben!):
 *        npx wrangler secret put ANTHROPIC_API_KEY
 *  3. Im Frontend-Widget (assistant_widget.html) die Konstante
 *        const PF_AI_ENDPOINT = 'https://DEIN-WORKER.workers.dev';
 *     auf die URL dieses Workers setzen.
 *  4. ALLOWED_ORIGIN unten auf deine Domain anpassen.
 * ─────────────────────────────────────────────────────────────
 */

const ALLOWED_ORIGIN = 'https://www.autohaus-pufahl.de'; // ggf. anpassen / '*' zum Testen

const SYSTEM_PROMPT = `Du bist der freundliche KI-Assistent von Autohaus Pufahl, einem Opel-Autohaus in Lengerich. Du beantwortest Fragen von Website-Besuchern kurz, hilfsbereit und auf Deutsch (oder in der Sprache des Nutzers). Du siezt höflich.

=== FAKTEN ÜBER AUTOHAUS PUFAHL ===
• Vollständiger Name: Autohaus Pufahl GmbH & Co. KG
• Familienbetrieb in vierter Generation, gegründet 1923 – 2023 wurde das 100-jährige Jubiläum gefeiert.
• Geschäftsführer: Jörg Pufahl
• Marke: Opel-Vertragspartner (Neuwagen). Bei Gebrauchtwagen markenübergreifend.

=== ADRESSE & KONTAKT ===
• Adresse: Münsterstraße 51, 49525 Lengerich (Nordrhein-Westfalen)
• Telefon: 05481 94000
• E-Mail: mail@autohaus-pufahl.de
• Website: www.autohaus-pufahl.de

=== ÖFFNUNGSZEITEN ===
• Montag bis Freitag: 08:00–17:00 Uhr (Kernzeiten 08:00–12:30 und 13:30–17:00 Uhr)
• Samstag & Sonntag: geschlossen
Für Termine außerhalb der Zeiten bitte telefonisch anfragen.

=== ANGEBOT / LEISTUNGEN ===
1. NEUWAGEN: Opel-Neuwagen sowie Vermittlung & Beratung. Konfiguration, Probefahrt und Finanzierung möglich.
2. GEBRAUCHTWAGEN: Geprüfte Gebrauchtwagen aller Marken. Aktueller Bestand auf der Website unter "Fahrzeuge".
3. SERVICE / MEISTERWERKSTATT (alle Marken): Inspektion & Wartung, Reparatur & Instandsetzung, HU/AU (TÜV), Reifenservice, Karosserie & Lack, Elektrik & Diagnose. Spezialität: Classic Cars / Oldtimer.
4. FINANZIERUNG: faire Finanzierungslösungen für Neu- und Gebrauchtwagen.

=== TEAM (9 Personen) ===
Jörg Pufahl (Verkaufsleitung), Andre Terlutter (KFZ-Meister), Klaus Wolff (KFZ-Meister Classic Cars), Frank Benner (KFZ-Mechatroniker), Florian Mielenbrink (KFZ-Mechatroniker), Julia Dittmann (Automobilkauffrau), Matthias Kienel (Fuhrparkmanager), Lara Schliek (Kaufm. Angestellte), Meike Hoffmann (Marketing).

=== VERHALTENSREGELN ===
• Antworte kurz und konkret (meist 1–4 Sätze). Keine langen Aufzählungen, außer der Nutzer fragt explizit danach.
• Bei Terminwünschen, Probefahrten, konkreten Preisen oder Fahrzeugverfügbarkeit: Du kennst keine tagesaktuellen Preise oder den Live-Bestand. Verweise freundlich auf Telefon (05481 94000), E-Mail (mail@autohaus-pufahl.de) oder die Seiten "Kontakt"/"Fahrzeuge".
• Erfinde NIEMALS Fakten, Preise, Fahrzeuge oder Aktionen. Wenn du etwas nicht weißt, sag das ehrlich.
• Bleib beim Thema Autohaus. Bei themenfremden Fragen lenke freundlich zurück.
• Sei warm, professionell und regional verbunden – wie ein hilfsbereiter Mitarbeiter am Empfang.`;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request, env) {
    const origin = ALLOWED_ORIGIN;

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: cors(origin) });
    }

    try {
      const { messages } = await request.json();

      if (!Array.isArray(messages) || messages.length === 0) {
        return Response.json({ error: 'no messages' }, { status: 400, headers: cors(origin) });
      }

      // Letzte 20 Nachrichten – schützt vor übermäßig langen Verläufen
      const trimmed = messages.slice(-20).map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0, 4000),
      }));

      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          system: SYSTEM_PROMPT,
          messages: trimmed,
        }),
      });

      if (!apiRes.ok) {
        const errTxt = await apiRes.text();
        console.error('Anthropic error:', errTxt);
        return Response.json(
          { reply: 'Entschuldigung, gerade ist der Assistent nicht erreichbar. Bitte rufen Sie uns an: 05481 94000.' },
          { status: 200, headers: cors(origin) }
        );
      }

      const data = await apiRes.json();
      const reply = (data.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim() || 'Entschuldigung, das habe ich nicht verstanden.';

      return Response.json({ reply }, { headers: cors(origin) });

    } catch (err) {
      console.error(err);
      return Response.json(
        { reply: 'Es gab ein technisches Problem. Bitte kontaktieren Sie uns unter 05481 94000 oder mail@autohaus-pufahl.de.' },
        { status: 200, headers: cors(origin) }
      );
    }
  },
};

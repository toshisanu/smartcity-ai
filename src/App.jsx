// src/App.jsx
import React, { useState, useEffect, useRef } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Rectangle
} from "react-leaflet";
import { Icon, divIcon, point } from "leaflet";
import { FaMicrophone } from "react-icons/fa";

import { auth, provider, db } from "./lib/firebase";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import {
  collection,
  addDoc,
  getDocs,
  doc,
  deleteDoc
} from "firebase/firestore";

// невидимая иконка (маркер используется для popup)
const invisibleIcon = new Icon({
  iconUrl: "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
  iconSize: [1, 1]
});

// видимая иконка для пользователя
const userIcon = new Icon({
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
  iconSize: [36, 36],
  iconAnchor: [18, 36],
});

// иконка-лейбл (DivIcon) для подписи внутри прямоугольника
function makeLabelIcon(text, color) {
  const safeText = String(text || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div style="
      font-size:12px;
      padding:4px 8px;
      border-radius:8px;
      background: rgba(255,255,255,0.92);
      color:${color};
      box-shadow:0 2px 6px rgba(0,0,0,0.12);
      border: 1px solid rgba(0,0,0,0.06);
      white-space:nowrap;
      font-weight:600;
    ">${safeText}</div>`;
  return divIcon({
    html,
    className: "scai-rect-label",
    iconSize: point(0, 0),
    iconAnchor: [0, 0],
    popupAnchor: [0, -10]
  });
}

// сопоставление уровня -> стиль прямоугольника
function getOverlayStyle(level) {
  if (level === "high")
    return { color: "#ef4444", fillColor: "#ef4444", fillOpacity: 0.30 }; // red-500
  if (level === "medium")
    return { color: "#f59e0b", fillColor: "#f59e0b", fillOpacity: 0.24 }; // amber-500
  return { color: "#10b981", fillColor: "#10b981", fillOpacity: 0.18 }; // emerald-500
}

// улучшенная система оценки опасности — возвращает "high" | "medium" | "low"
function computeDangerLevel(text) {
  if (!text) return "low";

  let t = String(text).toLowerCase();
  t = t.replace(/ё/g, "е");
  t = t.replace(/[^а-яё\s]/giu, " ");
  t = t.replace(/\s+/g, " ").trim();

  const weights = {
    "дтп": 10,
    "авари": 10,        // авария, аварии, аварию и т.д.
    "столкнов": 10,
    "пожар": 10,
    "взрыв": 10,
    "ранен": 8,
    "травм": 8,
    "перекрыт": 8,
    "убит": 9,
    "затор": 6,
    "пробк": 6,
    "ремонт": 6,
    "обвал": 7,
    "опрокинул": 7,
    "скольз": 5,
    "лед": 5,
    "гололед": 6,
    "ям": 3,
    "выбоин": 3,
    "гряз": 2,
    "луж": 2,
    "мусор": 1
  };

  const matches = [];
  let score = 0;
  for (const stem in weights) {
    const w = weights[stem];
    const re = new RegExp(`\\b${stem}[а-яё]*\\b`, "iu");
    if (re.test(t)) {
      score += w;
      matches.push({ stem, weight: w, method: "regex" });
      continue;
    }
    if (t.includes(stem)) {
      score += w;
      matches.push({ stem, weight: w, method: "includes" });
    }
  }

  if (/\b(очень|срочно|немедленно|критично|опасно)\b/.test(t)) {
    score += 3;
    matches.push({ stem: "urgency_booster", weight: 3, method: "booster" });
  }

  console.debug("[computeDangerLevel] text:", text, "-> normalized:", t, "matches:", matches, "score:", score);

  if (score >= 9) return "high";
  if (score >= 5) return "medium";
  return "low";
}

// формат времени
function formatTimestamp(ts) {
  if (!ts) return "";
  let ms;
  if (typeof ts === "number") ms = ts;
  else if (ts?.toMillis) ms = ts.toMillis();
  else ms = Date.now();
  const d = new Date(ms);
  return d.toLocaleString();
}

function App() {
  const [user, setUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [location, setLocation] = useState(null);
  const [hazards, setHazards] = useState([]); // newest first
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  const [showInstructions, setShowInstructions] = useState(() => {
    try {
      return localStorage.getItem("scai_instructions_shown") !== "1";
    } catch {
      return true;
    }
  });

  // функция для скрытия инструкций (с запоминанием)
  const hideInstructions = () => {
    try { localStorage.setItem("scai_instructions_shown", "1"); } catch {}
    setShowInstructions(false);
  };
  const showInstructionsNow = () => {
    try { localStorage.removeItem("scai_instructions_shown"); } catch {}
    setShowInstructions(true);
  };

  // жёстко заданный admin email
  const ADMIN_EMAIL = "lolkakaroto07@gmail.com";

  // референс карты, чтобы центрировать
  const mapRef = useRef(null);

  // геопозиция (только ставим метку пользователя)
  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const latlon = [pos.coords.latitude, pos.coords.longitude];
          setLocation(latlon);
        },
        (err) => console.error("Ошибка геолокации:", err),
        { enableHighAccuracy: true }
      );
    }
  }, []);

  // центрируем карту при смене location
  useEffect(() => {
    if (location && mapRef.current && typeof mapRef.current.setView === "function") {
      try {
        const map = mapRef.current;
        const currentZoom = map.getZoom ? map.getZoom() : 15;
        map.setView(location, currentZoom, { animate: true });
      } catch (e) {
        console.warn("Не удалось центрировать карту:", e);
      }
    }
  }, [location]);

  // слушаем auth, помечаем админа по email
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAdmin(!!(u && u.email && u.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()));
    });
    return () => unsub();
  }, []);

  // Сохраняем/удаляем признак при изменении showInstructions (защита от ошибок localStorage)
  useEffect(() => {
    try {
      if (!showInstructions) localStorage.setItem("scai_instructions_shown", "1");
      else localStorage.removeItem("scai_instructions_shown");
    } catch (e) {
      console.warn("localStorage error for instruction flag:", e);
    }
  }, [showInstructions]);

  // загрузка меток — нормализуем и сортируем по createdAt DESC (новые первыми)
  useEffect(() => {
    const fetchHazards = async () => {
      try {
        const snap = await getDocs(collection(db, "hazards"));
        const list = snap.docs.map((d) => {
          const data = d.data();
          const created = data.createdAt ?? Date.now();
          const createdAt = typeof created === "number" ? created : (created?.toMillis ? created.toMillis() : Date.now());
          return {
            id: d.id,
            text: data.text || "",
            coords: Array.isArray(data.coords) ? data.coords : (data.coordsLat && data.coordsLng ? [data.coordsLat, data.coordsLng] : null),
            danger: data.danger || computeDangerLevel(data.text || ""),
            address: data.address || (Array.isArray(data.coords) ? `${data.coords[0].toFixed(5)}, ${data.coords[1].toFixed(5)}` : "неизвестное место"),
            createdAt,
            reason: data.reason || null
          };
        });
        // сортировка по createdAt desc
        list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        setHazards(list);
      } catch (e) {
        console.warn("Ошибка чтения Firestore, читаем localStorage", e);
        const local = JSON.parse(localStorage.getItem("hazards") || "[]");
        const normalized = local.map(h => ({
          ...h,
          createdAt: h.createdAt ?? Date.now(),
          address: h.address ?? (h.coords ? `${h.coords[0].toFixed(5)}, ${h.coords[1].toFixed(5)}` : "неизвестно"),
          danger: h.danger ?? computeDangerLevel(h.text || ""),
          reason: h.reason || null
        }));
        normalized.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        setHazards(normalized);
      }
    };
    fetchHazards();
  }, []);

  // вход/выход
  const handleSignIn = async () => {
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      console.error("Ошибка входа:", e);
      alert(`Не удалось войти через Google.\nКод: ${e.code || "unknown"}\n${e.message || ""}`);
    }
  };
  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setUser(null);
      setIsAdmin(false);
    } catch (e) {
      console.error("Ошибка выхода:", e);
    }
  };

  // голосовой ассистент: подсказки + фиксация (без погоды)
  const startListening = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Браузер не поддерживает распознавание речи");
      return;
    }

    const rec = new SpeechRecognition();
    rec.lang = "ru-RU";
    rec.continuous = false;
    rec.interimResults = false;

    rec.onstart = () => setListening(true);
    rec.onend = () => setListening(false);

    rec.onresult = async (ev) => {
      const text = ev.results[0][0].transcript.toLowerCase();
      console.log("Распознано:", text);

      if (text.includes("удали")) {
        if (!isAdmin) {
          alert("Удалять метки могут только администраторы (войдите под админ-аккаунтом).");
          return;
        }
        alert("Чтобы удалить метку: нажмите 'Удалить' рядом с записью или в popup на карте. Чтобы удалить все — нажмите 'Удалить все метки'.");
        return;
      }

      // команда фиксации (слово "зафиксируй")
      if (text.includes("зафиксируй")) {
        const after = text.split("зафиксируй").pop().trim();
        const description = after || "инцидент";

        if (!location) {
          alert("Не удалось определить местоположение — включите геолокацию и попробуйте снова.");
          return;
        }

        const [lat, lon] = location;
        // без погоды: определяем только address через reverseGeocode (если нужно) — но чтобы не менять логику сильно, используем stored address via reverseGeocode inline:
        let address = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        try {
          const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
          const r = await fetch(url, { headers: { "User-Agent": "SmartCityAI/1.0" } });
          if (r.ok) {
            const j = await r.json();
            const road = j.address?.road || j.address?.pedestrian || j.address?.footway || "";
            const house = j.address?.house_number ? ` ${j.address.house_number}` : "";
            const city = j.address?.city || j.address?.town || j.address?.village || "";
            address = road ? road + house + (city ? `, ${city}` : "") : (j.display_name || address);
          }
        } catch (e) {
          console.warn("Reverse geocode failed:", e);
        }

        const danger = computeDangerLevel(description);

        // reason priority: explicit mention in description -> stored reason else null
        let explicitReason = null;
        const explicitRe = description.match(/\b(лед|гололед|гололёд|туман|авар|авария|дтп|столкнов|пожар)\b/i);
        if (explicitRe) explicitReason = explicitRe[0];

        const payloadForDb = {
          text: description,
          coords: [lat, lon],
          danger,
          address,
          reason: explicitReason || null,
          createdAt: Date.now()
        };

        try {
          const ref = await addDoc(collection(db, "hazards"), payloadForDb);
          const saved = { id: ref.id, ...payloadForDb };
          // добавляем в начало (новые сверху)
          setHazards(prev => {
            const next = [saved, ...prev];
            localStorage.setItem("hazards", JSON.stringify(next));
            return next;
          });
          alert(`Зафиксировано: ${description}\nАдрес: ${address}\nУровень: ${danger === "high" ? "высокий" : danger === "medium" ? "средний" : "низкий"}${explicitReason ? `\nПричина: ${explicitReason}` : ""}`);
        } catch (e) {
          console.error("Ошибка сохранения в Firestore:", e);
          const id = "local-" + Date.now();
          const saved = { id, ...payloadForDb };
          setHazards(prev => {
            const next = [saved, ...prev];
            localStorage.setItem("hazards", JSON.stringify(next));
            return next;
          });
          alert("Сохранение в облако не удалось, метка сохранена локально.");
        }
        return;
      }

      // fallback подсказка
      alert(
        "Команда не распознана.\n" +
        "Скажи: «Ассистент, зафиксируй инцидент [описание]»\n" +
        "Админы: «Ассистент, удали метку» — затем нажмите 'Удалить' или 'Удалить все метки'."
      );
    };

    recognitionRef.current = rec;
    rec.start();
  };

  // удалить одну метку — только админ
  const handleDelete = async (id) => {
    if (!isAdmin) { alert("Удалять метки могут только администраторы."); return; }
    if (!id && id !== 0) { alert("Неверный ID метки."); return; }

    const idStr = String(id);
    console.log("Попытка удалить метку id:", idStr, "typeof id:", typeof id, "isAdmin:", isAdmin);

    if (!confirm("Подтвердите удаление метки")) return;

    try {
      if (idStr.startsWith("local-")) {
        setHazards(prev => {
          const next = prev.filter(h => String(h.id) !== idStr);
          localStorage.setItem("hazards", JSON.stringify(next));
          return next;
        });
        alert("Локальная метка удалена.");
        return;
      }

      const docRef = doc(db, "hazards", idStr);
      console.log("Firestore delete docRef path:", docRef.path);

      await deleteDoc(docRef);

      setHazards(prev => {
        const next = prev.filter(h => String(h.id) !== idStr);
        localStorage.setItem("hazards", JSON.stringify(next));
        return next;
      });

      alert("Метка удалена из базы.");
    } catch (e) {
      console.error("Ошибка при удалении метки:", e);
      alert(`Ошибка при удалении.\nКод: ${e.code || "unknown"}\nСообщение: ${e.message || e}`);
    }
  };

  // удалить все метки — только админ
  const handleDeleteAll = async () => {
    if (!isAdmin) { alert("Только админ может удалить все метки."); return; }
    if (!confirm("Вы уверены? Это удалит ВСЕ метки в базе.")) return;

    try {
      const snap = await getDocs(collection(db, "hazards"));

      if (snap.empty) {
        setHazards([]);
        localStorage.removeItem("hazards");
        alert("Метки отсутствуют (ничего не удалено).");
        return;
      }

      for (const d of snap.docs) {
        console.log("Удаляем doc:", d.id);
        await deleteDoc(doc(db, "hazards", String(d.id)));
      }

      setHazards([]);
      localStorage.removeItem("hazards");
      alert("Все метки удалены.");
    } catch (e) {
      console.error("Ошибка при удалении всех меток:", e);
      alert(`Ошибка при удалении всех меток.\nКод: ${e.code || "unknown"}\nСообщение: ${e.message || e}`);
    }
  };

  // default center if location missing
  const defaultCenter = [43.238949, 76.889709];

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center font-sans text-slate-800">
      {/* Header */}
      <header className="w-full">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-11 h-11 rounded-lg bg-gradient-to-br from-indigo-600 to-cyan-500 flex items-center justify-center shadow-md">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="text-white">
                  <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" fill="white"/>
                </svg>
              </div>
              <div>
                <div className="text-lg font-semibold">SmartCity.AI</div>
                <div className="text-xs text-slate-400">Ассистент безопасности дорог</div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div>
                {user ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-700 px-3 py-1 bg-white border rounded-md shadow-sm">{user.displayName || user.email}</span>
                    <button onClick={handleSignOut} className="px-3 py-2 bg-white text-slate-700 border rounded-md hover:shadow transition">Выйти</button>
                  </div>
                ) : (
                  <button onClick={handleSignIn} className="px-4 py-2 bg-gradient-to-r from-emerald-500 to-teal-400 text-white rounded-md shadow hover:scale-[1.01] transition">Войти через Google</button>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Инструкция */}
      {showInstructions && (
        <div className="w-full max-w-6xl px-4 mt-4">
          <div className="bg-white rounded-xl shadow-lg p-4 border border-slate-100">
            <div className="flex justify-between items-start gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-800 mb-1">Инструкция — как пользоваться ассистентом</h3>
                <p className="text-sm text-slate-600 mb-2">
                  Скажите вслух: <span className="font-medium">«Ассистент, зафиксируй инцидент [описание]»</span>.
                </p>
                <p className="text-sm text-slate-600 mb-1">Примеры: «Ассистент, зафиксируй яму на дороге», «Ассистент, зафиксируй аварию».</p>
                <p className="text-sm text-slate-600">
                  Администратор <span className="font-semibold">SmartCity.AI</span> может удалять метки и использовать кнопку «Удалить все метки».
                </p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <button onClick={hideInstructions} className="px-3 py-1 bg-indigo-600 text-white rounded-md shadow-sm">Понял — скрыть</button>
                <button onClick={() => { setShowInstructions(false); setTimeout(() => setShowInstructions(true), 10); }} className="px-3 py-1 bg-slate-50 text-slate-700 rounded-md border">Перемигнуть</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {!showInstructions && (
        <div className="w-full max-w-6xl px-4 mt-3 flex justify-end">
          <button onClick={showInstructionsNow} className="px-3 py-1 bg-white text-slate-700 border rounded-md">Показать инструкцию</button>
        </div>
      )}

      <div className="w-full max-w-6xl px-4 mt-4">
        <div className="flex justify-between items-center mb-3">
          {/* оставляем только кнопку удаления всех меток для админа (профиль/вход уже в шапке) */}
          <div></div>
          <div className="flex gap-2 items-center">
            {isAdmin && (
              <button onClick={handleDeleteAll} className="px-3 py-2 bg-red-600 text-white rounded-md shadow">🗑 Удалить все метки</button>
            )}
          </div>
        </div>

        <div className="flex justify-center mb-4">
          <button
            onClick={startListening}
            className={`flex items-center gap-3 px-6 py-3 rounded-full text-lg font-semibold shadow-md transition ${
              listening ? "bg-red-500 text-white animate-pulse" : "bg-gradient-to-r from-sky-500 to-indigo-500 text-white hover:scale-[1.02]"
            }`}
          >
            <FaMicrophone /> {listening ? "Слушаю..." : "Ассистент 🎤"}
          </button>
        </div>

        <div className="mt-2 w-full h-[560px] rounded-xl overflow-hidden shadow-lg border">
          {location ? (
            <MapContainer
              center={location}
              zoom={15}
              style={{ height: "100%", width: "100%" }}
              whenCreated={(m) => (mapRef.current = m)}
            >
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />

              {/* видимый маркер пользователя */}
              {location && (
                <Marker position={location} icon={userIcon}>
                  <Popup>
                    <div className="text-sm">
                      <div className="font-medium">Вы здесь</div>
                    </div>
                  </Popup>
                </Marker>
              )}

              {hazards.map(h => {
                const coords = Array.isArray(h.coords) && h.coords.length >= 2 ? h.coords : null;
                if (!coords) return null;
                const [lat, lon] = coords;
                // прямоугольник: ширина больше высоты
                const latOffset = 0.00018; // ~20м
                const lonOffset = 0.00042; // ~40м
                const bounds = [
                  [lat - latOffset, lon - lonOffset],
                  [lat + latOffset, lon + lonOffset]
                ];
                const style = getOverlayStyle(h.danger);

                // determine visible reason: prefer explicit reason stored in DB or inferred from text
                const explicitRe = (h.text || "").match(/\b(лед|гололед|гололёд|туман|авар|авария|дтп|столкнов|пожар)\b/i);
                const explicitReason = h.reason || (explicitRe ? explicitRe[0] : null);
                const reason = explicitReason || null;

                // label color based on danger
                const labelColor = h.danger === "high" ? "#b91c1c" : h.danger === "medium" ? "#b45309" : "#0f766e";
                const labelText = reason ? reason : (h.text.length > 18 ? h.text.slice(0, 18) + "…" : h.text || "инцидент");

                // center for label marker
                const center = [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2];

                return (
                  <React.Fragment key={h.id}>
                    <Rectangle bounds={bounds} pathOptions={style} />
                    {/* label marker in center (shows reason) */}
                    <Marker position={center} icon={makeLabelIcon(labelText, labelColor)} interactive={false} />
                    <Marker position={[lat, lon]} icon={invisibleIcon}>
                      <Popup>
                        <div className="max-w-xs">
                          <div className="font-semibold text-slate-800">{h.text}</div>
                          <div className="text-sm text-slate-600 mt-1">
                            Уровень: <span className={h.danger === "high" ? "font-semibold text-red-600" : h.danger === "medium" ? "font-semibold text-amber-600" : "font-semibold text-emerald-600"}>
                              {h.danger === "high" ? "Высокая" : h.danger === "medium" ? "Средняя" : "Низкая"}
                            </span>
                          </div>
                          {reason && <div className="text-sm text-slate-700 mt-1">Причина: <span className="font-medium">{reason}</span></div>}
                          <div className="text-xs text-slate-500 mt-2">Адрес: {h.address}</div>
                          <div className="text-xs text-slate-400">Добавлено: {formatTimestamp(h.createdAt)}</div>
                          {isAdmin && (
                            <div className="mt-3">
                              <button onClick={() => handleDelete(h.id)} className="px-2 py-1 bg-red-600 text-white rounded-md shadow-sm">Удалить</button>
                            </div>
                          )}
                        </div>
                      </Popup>
                    </Marker>
                  </React.Fragment>
                );
              })}
            </MapContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-slate-500">Определяем местоположение...</div>
          )}
        </div>

        <section className="mt-6">
          <h2 className="text-lg font-semibold mb-2">📋 Зафиксированные инциденты (новые сверху)</h2>
          <div className="bg-white p-4 rounded-xl shadow-sm border">
            {hazards.length === 0 ? (
              <p className="text-slate-500">Пока ничего не зафиксировано.</p>
            ) : hazards.map(h => (
              <div key={h.id} className="border-b last:border-b-0 py-3 flex justify-between items-start">
                <div>
                  <div className="font-medium text-slate-800">{h.text}</div>
                  <div className="text-sm text-slate-600 mt-1">Уровень: <span className={h.danger === "high" ? "font-semibold text-red-600" : h.danger === "medium" ? "font-semibold text-amber-600" : "font-semibold text-emerald-600"}>{h.danger === "high" ? "Высокая" : h.danger === "medium" ? "Средняя" : "Низкая"}</span></div>
                  <div className="text-xs text-slate-500 mt-1">Адрес: {h.address}</div>
                  <div className="text-xs text-slate-400 mt-1">Добавлено: {formatTimestamp(h.createdAt)}</div>
                  {h.reason && <div className="text-xs text-slate-700 mt-1">Причина: <span className="font-medium">{h.reason}</span></div>}
                </div>
                {isAdmin && (
                  <div>
                    <button onClick={() => handleDelete(h.id)} className="px-2 py-1 bg-red-600 text-white rounded-md shadow-sm">Удалить</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>

      <footer className="w-full mt-8">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="text-sm text-slate-500 text-center">© 2025 SmartCity.AI | Разумный город — безопасные дороги</div>
        </div>
      </footer>
    </div>
  );
}

export default App;

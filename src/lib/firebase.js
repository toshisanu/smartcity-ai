// src/lib/firebase.js
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, onAuthStateChanged } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Конфигурация из .env
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// Проверка наличия переменных окружения
Object.entries(firebaseConfig).forEach(([key, value]) => {
  if (!value) {
    console.error(`❌ Отсутствует переменная окружения: ${key}`);
  }
});

try {
  console.log("✅ Firebase config загружен:", firebaseConfig.projectId);
} catch (e) {
  console.warn("⚠️ Firebase config не удалось вывести:", e);
}

// Инициализация Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
export const db = getFirestore(app);

// Функция-слушатель изменений пользователя
export function watchAuthState(callback) {
  return onAuthStateChanged(auth, (user) => callback(user));
}

export default app;

#!/bin/bash
# Ждёт завершения текущего build-knowledge-base.js, потом запускает новый с обновлёнными разделами.

KB_LOG="/Users/tafichuk/bitrix-localizer/backend/kb-build.log"
KB_ARTICLES="/Users/tafichuk/bitrix-localizer/backend/kb-articles.json"

echo "⏳ Жду завершения текущего процесса..."

# Ждём пока процесс не завершится
while pgrep -f "build-knowledge-base.js" > /dev/null 2>&1; do
  PROGRESS=$(grep -c "^\[" "$KB_LOG" 2>/dev/null || echo 0)
  PATTERNS=$(grep -o '"verified":false' /Users/tafichuk/bitrix-localizer/backend/knowledge-base.json 2>/dev/null | wc -l | tr -d ' ')
  echo "  📊 Статей: $PROGRESS/312, паттернов: $PATTERNS"
  sleep 60
done

echo ""
echo "✅ Текущий процесс завершён!"
echo ""

# Показываем итог
FINAL_LOG=$(tail -5 "$KB_LOG")
echo "Последние строки лога:"
echo "$FINAL_LOG"
echo ""

# Удаляем кэш URL-ов чтобы пересканировать с новыми разделами
echo "🗑️  Удаляю кэш kb-articles.json (будет пересканировано с 38 разделами)..."
rm -f "$KB_ARTICLES"

# Запускаем с новыми разделами
echo "🚀 Запускаю build-knowledge-base.js с обновлёнными 38 разделами..."
cd /Users/tafichuk/bitrix-localizer/backend

railway run --service bitrix-localizer-backend node build-knowledge-base.js >> kb-build-phase2.log 2>&1

echo "✅ Фаза 2 завершена! Смотри kb-build-phase2.log"

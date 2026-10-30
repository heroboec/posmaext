# HTML страниц заявок

Снимки из диалога 17 октября 2026; ключевые селекторы сверены с кодом 2.8.
На живом сайте актуальность не проверялась. Полные исходники доступны по ссылкам
на локальную историю в project-context.md; значения токенов и аккаунтов сюда не перенесены.

## Список

- Основная строка: `tr.tr_default.bids-tr-table-new`.
- Детали: следующая строка `tr.tr-hidden-bid.tr-hidden-bid-{id}`.
- Категория: `div[data-section-category]`, внутри span с названием и img с иконкой.
- ID/раскрытие: `a[data-bid-id-show-section]`.
- Редактирование свойств: `a.bid-macro-values-edit-outside-link`.
- Статус: `#status_id{id}`, fallback `select[name="status"]`.
- В исходном select есть `data-current-status` и inline onchange
  `admin_bids.change_status(id, value)`. Для выбора 4 расширение теперь открывает
  своё окно с шаблонами через capture-обработчик change и подавляет inline обработчик.
  Дополнительно MAIN-world page-bridge.js перехватывает прямые вызовы
  admin_bids.change_status для статуса 4. Прежний статус восстанавливается до
  подтверждения, остальные значения не перехватываются.
- Расширение скрывает основную и соседнюю строку классом `pm-hidden-by-filter`.

В деталях присутствуют свойства, указанные поставщиком:

- Текст товара: `span[data-text-item="{id}"]`, редактирование `.txt-{id}`.
- Прокси: `.field-view-proxy`; страна: `.field-view-country`;
  формат: `.field-view-format` (копируемое значение может быть в data-value).
- Макросы: `div.bids-table-new-params.bid-macro-display-row`;
  подпись в span, значение в `.section-bids-item .field-view`.
  Например подтверждение почты, пол, Cookies, GEO, формат, способ входа и 2FA.
- Есть цена поставщика за аккаунт, цена магазина `.field-view-cost` /
  `input.field-edit-cost`, статистика партнёра (всего, отклонено, процент).

В основной строке связанному товару каталога соответствуют `#item_control_{id} a`,
`.product-info[title]`, `.bids-template-generated-mark` (шаблонная карточка),
вызов `admin_bids.item_id_dialog(bidId, itemId)`. Это отличается от свойств поставщика.

## Форма свойств

URL: `/bids/macro-values/{bidId}`.
`form#bid-macro-values-edit-form`, method post,
action `/bids/macro-values-save/{bidId}`.
Кнопка «Сохранить значения»: `.catalog-template-actions button[type="submit"]`.

Контейнер `.catalog-template-form-grid`, непосредственные дети `.catalog-template-field`:

- `.catalog-template-label-text` — подпись; `span.red` со звёздочкой — обязательность.
- `.catalog-template-code` — код макроса, например `[GEO_COUNTRY]`.
- `.catalog-template-field-control` — select или textarea; текущий код также
  распознаёт input type text и input без type.
- name контролов: `macro_values[%5BCODE%5D]`, локализация добавляет `[ru]`;
  локализованные поля обёрнуты в `label.catalog-template-localized-control`.
- required на контроле — второй признак обязательности.
- `.catalog-template-hint` — подсказка.

В примере TikTok были EMAIL_VERIFICATION, EMAIL_ACCESS_STATUS (обязательный),
SMS_VERIFICATION, GENDER_GENERAL, TIKTOK_PROFILE_FILL_STATUS, TWOFA_STATUS,
COOKIES_INCLUDED, USER_AGENT_STATUS, IS_USED, GEO_COUNTRY (обязательный),
EMAIL_CUSTOM_DOMAIN_LOGIN_URL, FORMAT (обязательный, ru, до 255 символов), LOGIN_APPROACH.
Набор зависит от категории; не фиксировать его как универсальный.

`section.catalog-template-account-samples ol li code` — примеры аккаунтов только для
чтения; содержат реальные учётные данные, не логировать и не экспортировать.
`meta[name="csrf-token"]` — источник CSRF для запросов.
В исходном HTML также был скрытый отладочный блок с данными сессии: не переносить его.

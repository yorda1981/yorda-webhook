-- Desglose del pago a la compañera: subtotal de entregas, frete y total.
ALTER TABLE entregas_pagos
    ADD COLUMN IF NOT EXISTS frete_usdt NUMERIC NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS subtotal_usdt NUMERIC,
    ADD COLUMN IF NOT EXISTS total_usdt NUMERIC;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entregas_pagos_frete_usdt_nonnegative') THEN
        ALTER TABLE entregas_pagos ADD CONSTRAINT entregas_pagos_frete_usdt_nonnegative CHECK (frete_usdt >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entregas_pagos_subtotal_usdt_nonnegative') THEN
        ALTER TABLE entregas_pagos ADD CONSTRAINT entregas_pagos_subtotal_usdt_nonnegative CHECK (subtotal_usdt IS NULL OR subtotal_usdt >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entregas_pagos_total_usdt_nonnegative') THEN
        ALTER TABLE entregas_pagos ADD CONSTRAINT entregas_pagos_total_usdt_nonnegative CHECK (total_usdt IS NULL OR total_usdt >= 0);
    END IF;
END $$;

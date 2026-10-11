"use strict";

// Estados persistidos de una publicación del Content Center. Los borradores
// viven como content_items + content_revisions; una publicación nace solo al
// elegir "publicar ahora" o programar una fecha.
const PUBLICATION_STATES = Object.freeze({
    SCHEDULED: "PROGRAMADA",
    PUBLISHING: "PUBLICANDO",
    PUBLISHED: "PUBLICADA",
    FAILED: "FALLIDA",
    AMBIGUOUS: "AMBIGUA",
    CANCELED: "CANCELADA"
});

const TRANSITIONS = Object.freeze({
    [PUBLICATION_STATES.SCHEDULED]: Object.freeze([
        PUBLICATION_STATES.PUBLISHING,
        PUBLICATION_STATES.CANCELED
    ]),
    [PUBLICATION_STATES.PUBLISHING]: Object.freeze([
        PUBLICATION_STATES.PUBLISHED,
        PUBLICATION_STATES.FAILED,
        PUBLICATION_STATES.AMBIGUOUS
    ]),
    // El reintento manual aprobado crea un intento nuevo sobre la misma
    // publicación y vuelve a reclamarla explícitamente.
    [PUBLICATION_STATES.FAILED]: Object.freeze([
        PUBLICATION_STATES.PUBLISHING
    ]),
    [PUBLICATION_STATES.PUBLISHED]: Object.freeze([]),
    [PUBLICATION_STATES.AMBIGUOUS]: Object.freeze([]),
    [PUBLICATION_STATES.CANCELED]: Object.freeze([])
});

function isPublicationState(value) {
    return Object.values(PUBLICATION_STATES).includes(value);
}

function canTransitionPublication(from, to) {
    if (!isPublicationState(from) || !isPublicationState(to)) return false;
    return TRANSITIONS[from].includes(to);
}

function assertPublicationTransition(from, to) {
    if (!canTransitionPublication(from, to)) {
        const error = new Error(`Transición de publicación inválida: ${from} -> ${to}`);
        error.code = "CONTENT_PUBLICATION_INVALID_TRANSITION";
        throw error;
    }
}

module.exports = {
    PUBLICATION_STATES,
    TRANSITIONS,
    isPublicationState,
    canTransitionPublication,
    assertPublicationTransition
};

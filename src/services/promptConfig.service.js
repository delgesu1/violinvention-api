const logger = require('../config/logger');
const promptConfig = require('../config/promptConfig.json');

class PromptConfigService {
  constructor() {
    this.config = promptConfig;
    logger.info(`[PromptConfigService] Loaded config version ${this.config.version}`);
  }

  getAvailableInstruments() {
    return Object.keys(this.config.prompts.summarization.instruments).map((key) => ({
      key,
      displayName: this.config.prompts.summarization.instruments[key].displayName,
    }));
  }

  getAvailableGenres() {
    return Object.keys(this.config.prompts.summarization.genres).map((key) => ({
      key,
      displayName: this.config.prompts.summarization.genres[key].displayName,
    }));
  }

  generateSummaryPrompt(instrument = 'violin', genre = 'classical') {
    try {
      const base = this.config.prompts.summarization.base;
      const instrumentConfig =
        this.config.prompts.summarization.instruments[instrument] ||
        this.config.prompts.summarization.instruments.violin;
      const genreConfig =
        this.config.prompts.summarization.genres[genre] ||
        this.config.prompts.summarization.genres.classical;

      let prompt = base.instruction;

      prompt = prompt.replace(/\{\{INSTRUMENT\}\}/g, instrumentConfig.displayName.toLowerCase());
      prompt = prompt.replace(
        /\{\{INSTRUMENT_UPPER\}\}/g,
        instrumentConfig.instrumentUpper || instrumentConfig.displayName.toUpperCase()
      );
      prompt = prompt.replace(
        /\{\{MUSICIAN_TERM\}\}/g,
        instrumentConfig.musicianTerm || `${instrumentConfig.displayName.toLowerCase()}ist`
      );
      prompt = prompt.replace(/\{\{TECHNICAL_DETAILS\}\}/g, instrumentConfig.technicalDetails || 'technical details');
      prompt = prompt.replace(
        /\{\{GENERIC_TECHNIQUE_REFERENCE\}\}/g,
        instrumentConfig.genericTechniqueReference || 'Technique'
      );
      prompt = prompt.replace(/\{\{PRACTICE_CONTEXT\}\}/g, instrumentConfig.practiceContext || 'practice');
      prompt = prompt.replace(/\{\{WORK_EXAMPLE_1\}\}/g, instrumentConfig.workExample1 || 'Example Piece 1');
      prompt = prompt.replace(/\{\{WORK_DESCRIPTION_1\}\}/g, instrumentConfig.workDescription1 || 'specific section');
      prompt = prompt.replace(/\{\{ASSIGNMENT_EXAMPLE\}\}/g, instrumentConfig.assignmentExample || 'Assigned Piece');
      prompt = prompt.replace(/\{\{SCALE_ASSIGNMENT\}\}/g, instrumentConfig.scaleAssignment || 'scales');
      prompt = prompt.replace(/\{\{WORK_EXAMPLE_2\}\}/g, instrumentConfig.workExample2 || 'Example Piece 2');
      prompt = prompt.replace(/\{\{SCALE_EXAMPLE\}\}/g, instrumentConfig.scaleExample || 'Scales practice');
      prompt = prompt.replace(/\{\{ETUDE_EXAMPLE\}\}/g, instrumentConfig.etudeExample || 'Etude practice');
      prompt = prompt.replace(/\{\{ASSIGNMENT_EXAMPLE_2\}\}/g, instrumentConfig.assignmentExample2 || 'Next week assignments');
      prompt = prompt.replace(/\{\{TECHNIQUE_EXAMPLE_1\}\}/g, instrumentConfig.techniqueExample1 || 'Core Technique Focus');
      prompt = prompt.replace(/\{\{TECHNIQUE_EXAMPLE_2\}\}/g, instrumentConfig.techniqueExample2 || 'Sound Development');
      prompt = prompt.replace(/\{\{TECHNIQUE_LIST\}\}/g, instrumentConfig.techniqueList || 'key techniques');

      prompt = prompt.replace(/\{\{PIECES_TERM\}\}/g, genreConfig.piecesTerms);
      prompt = prompt.replace(
        /\{\{TERMINOLOGY_SCOPE\}\}/g,
        genreConfig.terminologyScope.replace(/\{\{INSTRUMENT\}\}/g, instrumentConfig.displayName.toLowerCase())
      );
      prompt = prompt.replace(/\{\{REFERENCE_EXAMPLES\}\}/g, genreConfig.referenceExamples);

      logger.debug(`[PromptConfigService] Generated summary prompt for ${instrument}/${genre}`);
      return prompt;
    } catch (error) {
      logger.error('[PromptConfigService] Error generating summary prompt:', error);
      return this.config.prompts.summarization.base.instruction.replace(/\{\{INSTRUMENT\}\}/g, 'instrument');
    }
  }

  generateTitlePrompt(instrument = 'violin', genre = 'classical', hasStudentName = false) {
    try {
      const instrumentConfig =
        this.config.prompts.summarization.instruments[instrument] ||
        this.config.prompts.summarization.instruments.violin;
      const genreConfig =
        this.config.prompts.summarization.genres[genre] ||
        this.config.prompts.summarization.genres.classical;

      let prompt = this.config.prompts.titleGeneration.base;

      prompt = prompt.replace(/\{\{INSTRUMENT\}\}/g, instrumentConfig.displayName.toLowerCase());

      const titleVars = genreConfig.titleVars;
      prompt = prompt.replace(/\{\{LABEL_TYPE\}\}/g, titleVars.labelType);
      prompt = prompt.replace(/\{\{SINGULAR_LABEL\}\}/g, titleVars.singularLabel);
      prompt = prompt.replace(/\{\{PLURAL_LABEL\}\}/g, titleVars.pluralLabel);
      prompt = prompt.replace(/\{\{LABEL_FORMAT\}\}/g, titleVars.labelFormat);
      prompt = prompt.replace(/\{\{EXAMPLE_FORMAT\}\}/g, titleVars.exampleFormat);
      prompt = prompt.replace(/\{\{TECHNIQUE_EXAMPLES\}\}/g, titleVars.techniqueExamples);

      if (hasStudentName) {
        prompt = `${this.config.prompts.titleGeneration.withStudent}\n\n${prompt}`;
      }

      logger.debug(`[PromptConfigService] Generated title prompt for ${instrument}/${genre}`);
      return prompt;
    } catch (error) {
      logger.error('[PromptConfigService] Error generating title prompt:', error);
      return this.config.prompts.titleGeneration.base;
    }
  }

  generateTagExtractionPrompt(instrument = 'violin', genre = 'classical') {
    try {
      const instrumentConfig =
        this.config.prompts.summarization.instruments[instrument] ||
        this.config.prompts.summarization.instruments.violin;
      const tagPromptConfig = this.config.prompts.tagExtraction || {};
      let prompt = tagPromptConfig.base || tagPromptConfig.legacyBase;
      if (!prompt) {
        throw new Error('Missing tag extraction prompt template');
      }

      prompt = prompt.replace(/\{\{INSTRUMENT\}\}/g, instrumentConfig.displayName.toLowerCase());

      /**
       * Legacy multi-tag prompt builder retained for reference.
       * If we revert to multi-category tags, re-enable the logic below.
       *
       * const genreConfig = this.config.prompts.summarization.genres[genre] ||
       *                    this.config.prompts.summarization.genres['classical'];
       * const tagConfig = tagPromptConfig.instrumentSpecific[instrument] ||
       *                  tagPromptConfig.instrumentSpecific['violin'];
       * ... legacy replacements ...
       */

      logger.debug(`[PromptConfigService] Generated tag extraction prompt for ${instrument}/${genre}`);
      return prompt;
    } catch (error) {
      logger.error('[PromptConfigService] Error generating tag extraction prompt:', error);
      return this.config.prompts.tagExtraction.base;
    }
  }

  isValidInstrument(instrument) {
    return Boolean(instrument && this.config.prompts.summarization.instruments[instrument]);
  }

  isValidGenre(genre) {
    return Boolean(genre && this.config.prompts.summarization.genres[genre]);
  }

  getInstrumentDisplayName(instrument) {
    const config = this.config.prompts.summarization.instruments[instrument];
    return config ? config.displayName : instrument;
  }

  getGenreDisplayName(genre) {
    const config = this.config.prompts.summarization.genres[genre];
    return config ? config.displayName : genre;
  }
}

module.exports = new PromptConfigService();

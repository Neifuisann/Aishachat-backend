import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import './types.d.ts';
import { Logger } from './logger.ts';

const logger = new Logger('[Reading]');

/**
 * Enhanced Reading Manager with Supabase integration and better user experience
 *
 * Key improvements:
 * - Fetches books from Supabase books table
 * - Reads content from Supabase storage bucket
 * - Implements recap system for continuity
 * - Better navigation with categories and search
 * - Improved AI guidance through prompts
 */
export async function ReadingManager(
    supabase: SupabaseClient,
    userId: string,
    mode: 'Browse' | 'Continue' | 'Search' | 'Navigate' | 'Settings' | 'Bookmark',
    action: string,
    bookId?: string | null,
    searchQuery?: string | null,
    pageNumber?: number | null,
    readingMode?: 'paragraphs' | 'sentences' | 'fullpage' | null,
    readingAmount?: number | null,
): Promise<{ success: boolean; data?: any; message: string }> {
    logger.info(`ReadingManager called: mode=${mode}, action=${action}, userId=${userId}`);

    try {
        switch (mode) {
            case 'Browse':
                return await handleBrowseMode(supabase, userId, action);

            case 'Continue':
                return await handleContinueMode(supabase, userId, bookId);

            case 'Search':
                return await handleSearchMode(supabase, userId, searchQuery);

            case 'Navigate':
                return await handleNavigateMode(supabase, userId, bookId, action, pageNumber);

            case 'Settings':
                return await handleSettingsMode(
                    supabase,
                    userId,
                    action,
                    readingMode,
                    readingAmount,
                );

            case 'Bookmark':
                return await handleBookmarkMode(supabase, userId, bookId, action, pageNumber);

            default:
                return { success: false, message: 'Invalid mode selected.' };
        }
    } catch (err) {
        logger.error(`Error in ReadingManager:`, err);
        return { success: false, message: `An error occurred: ${err}` };
    }
}

/**
 * Browse books with categories
 */
async function handleBrowseMode(
    supabase: SupabaseClient,
    userId: string,
    action: string,
): Promise<{ success: boolean; data?: any; message: string }> {
    if (action === 'MyBooks') {
        // Get user's reading history and private books
        const { data: books, error } = await supabase
            .from('books')
            .select(`
                book_id,
                book_name,
                author,
                description,
                total_pages,
                is_public,
                created_at
            `)
            .or(`is_public.eq.true,uploaded_by.eq.${userId}`)
            .order('book_name');

        if (error) {
            return { success: false, message: `Error fetching books: ${error.message}` };
        }

        // Get reading progress for each book
        const { data: history } = await supabase
            .from('reading_history')
            .select('book_name, current_page, last_read_at')
            .eq('user_id', userId);

        const historyMap = new Map(history?.map((h) => [h.book_name, h]) || []);

        // Categorize books
        const inProgress = [];
        const notStarted = [];
        const privateBooks = [];

        for (const book of books || []) {
            const progress = historyMap.get(book.book_name);
            const bookInfo = {
                ...book,
                currentPage: progress?.current_page || 0,
                lastRead: progress?.last_read_at,
                progress: progress
                    ? `${Math.round((progress.current_page / book.total_pages) * 100)}%`
                    : 'Not started',
            };

            if (!book.is_public) {
                privateBooks.push(bookInfo);
            } else if (progress && progress.current_page > 0) {
                inProgress.push(bookInfo);
            } else {
                notStarted.push(bookInfo);
            }
        }

        let message = '📚 **Your Library**\n\n';

        if (inProgress.length > 0) {
            message += '**Currently Reading:**\n';
            inProgress.forEach((book, idx) => {
                message += `${idx + 1}. "${book.book_name}"${
                    book.author ? ` by ${book.author}` : ''
                } - Page ${book.currentPage}/${book.total_pages} (${book.progress})\n`;
            });
            message += '\n';
        }

        if (privateBooks.length > 0) {
            message += '**Your Private Books:**\n';
            privateBooks.forEach((book, idx) => {
                message += `${idx + 1}. "${book.book_name}"${
                    book.author ? ` by ${book.author}` : ''
                } - ${book.progress}\n`;
            });
            message += '\n';
        }

        if (notStarted.length > 0) {
            message += '**Available Books:**\n';
            notStarted.forEach((book, idx) => {
                message += `${idx + 1}. "${book.book_name}"${
                    book.author ? ` by ${book.author}` : ''
                }\n`;
            });
        }

        message += '\n💡 **What would you like to do?**\n';
        message += "• Say 'Continue reading [book name]' to resume\n";
        message += "• Say 'Start reading [book name]' to begin a new book\n";
        message += "• Say 'Search for [topic/author]' to find specific books";

        return {
            success: true,
            data: { inProgress, privateBooks, notStarted, total: books?.length || 0 },
            message,
        };
    } else if (action === 'Recent') {
        // Get recently read books
        const { data: recentHistory, error } = await supabase
            .from('reading_history')
            .select(`
                book_name,
                current_page,
                total_pages,
                last_read_at
            `)
            .eq('user_id', userId)
            .order('last_read_at', { ascending: false })
            .limit(5);

        if (error) {
            return { success: false, message: `Error fetching recent books: ${error.message}` };
        }

        if (!recentHistory || recentHistory.length === 0) {
            return {
                success: true,
                data: { recent: [] },
                message:
                    "You haven't read any books yet. Say 'Show me all books' to browse our library!",
            };
        }

        let message = '📖 **Recently Read:**\n\n';
        recentHistory.forEach((item, idx) => {
            const progress = Math.round((item.current_page / item.total_pages) * 100);
            const lastRead = new Date(item.last_read_at).toLocaleDateString();
            message += `${
                idx + 1
            }. "${item.book_name}" - Page ${item.current_page}/${item.total_pages} (${progress}%) - Last read: ${lastRead}\n`;
        });

        message += "\n💡 Say 'Continue reading [book name]' to resume any book!";

        return {
            success: true,
            data: { recent: recentHistory },
            message,
        };
    }

    return { success: false, message: "Invalid browse action. Try 'My books' or 'Recent books'." };
}

/**
 * Continue reading with recap
 */
async function handleContinueMode(
    supabase: SupabaseClient,
    userId: string,
    bookId?: string | null,
): Promise<{ success: boolean; data?: any; message: string }> {
    if (!bookId) {
        // Get the most recently read book
        const { data: recent, error } = await supabase
            .from('reading_history')
            .select('book_name')
            .eq('user_id', userId)
            .order('last_read_at', { ascending: false })
            .limit(1)
            .single();

        if (error || !recent) {
            return {
                success: false,
                message: "No reading history found. Say 'Show me all books' to start reading!",
            };
        }

        // Get book ID from book name
        const { data: book } = await supabase
            .from('books')
            .select('book_id')
            .eq('book_name', recent.book_name)
            .single();

        bookId = book?.book_id;
    }

    // Get book details and reading progress
    const { data: book, error: bookError } = await supabase
        .from('books')
        .select('*')
        .eq('book_id', bookId)
        .single();

    if (bookError || !book) {
        return { success: false, message: 'Book not found.' };
    }

    const { data: history, error: historyError } = await supabase
        .from('reading_history')
        .select('*')
        .eq('user_id', userId)
        .eq('book_name', book.book_name)
        .single();

    if (historyError || !history || history.current_page === 0) {
        return {
            success: false,
            message:
                `You haven't started reading "${book.book_name}" yet. Say 'Start reading ${book.book_name}' to begin!`,
        };
    }

    // Generate recap of previous pages
    const recap = await generateRecap(supabase, book, history.current_page);

    // Read current page
    const pageContent = await readPageFromStorage(supabase, book.file_path, history.current_page);

    if (!pageContent.success) {
        return pageContent;
    }

    // Get reading settings
    const { data: settings } = await supabase
        .from('reading_settings')
        .select('*')
        .eq('user_id', userId)
        .single();

    const readingMode = settings?.reading_mode || 'fullpage';
    const readingAmount = settings?.reading_amount || 1;

    // Apply reading mode to content
    const processedContent = applyReadingMode(pageContent.data.content, readingMode, readingAmount);

    let message =
        `📖 **"${book.book_name}" - Page ${history.current_page}/${book.total_pages}**\n\n`;

    if (recap) {
        message += `📝 **Previously:** ${recap}\n\n`;
        message += '---\n\n';
    }

    message += processedContent;

    message += '\n\n💡 **Options:**\n';
    message += "• Say 'Next page' or 'Continue' to keep reading\n";
    message += "• Say 'Previous page' to go back\n";
    message += "• Say 'Go to page [number]' to jump to a specific page\n";
    message += "• Say 'Bookmark this page' to save your spot";

    // Update last read timestamp
    await supabase
        .from('reading_history')
        .update({ last_read_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('book_name', book.book_name);

    return {
        success: true,
        data: {
            book,
            currentPage: history.current_page,
            content: processedContent,
            recap,
            readingMode,
            readingAmount,
        },
        message,
    };
}

/**
 * Generate a recap of previous pages
 */
async function generateRecap(
    supabase: SupabaseClient,
    book: any,
    currentPage: number,
): Promise<string | null> {
    if (currentPage <= 1) return null;

    try {
        // Read previous 1-2 pages for context
        const pagesToRecap = Math.min(2, currentPage - 1);
        let recapContent = '';

        for (let i = currentPage - pagesToRecap; i < currentPage; i++) {
            const pageResult = await readPageFromStorage(supabase, book.file_path, i);
            if (pageResult.success) {
                recapContent += pageResult.data.content + ' ';
            }
        }

        if (!recapContent) return null;

        // Simple summarization: Take first few sentences
        // In production, you might want to use an AI service for better summarization
        const sentences = recapContent.match(/[^.!?]+[.!?]+/g) || [];
        const summary = sentences.slice(0, 3).join(' ').trim();

        return summary || null;
    } catch (err) {
        logger.error('Error generating recap:', err);
        return null;
    }
}

/**
 * Read page content from Supabase storage
 */
async function readPageFromStorage(
    supabase: SupabaseClient,
    filePath: string,
    pageNumber: number,
): Promise<{ success: boolean; data?: any; message: string }> {
    try {
        // Download the book file from storage
        const { data, error } = await supabase.storage
            .from('books')
            .download(filePath);

        if (error) {
            logger.error('Storage error:', error);
            return { success: false, message: `Error accessing book file: ${error.message}` };
        }

        // Convert blob to text
        const text = await data.text();

        // Parse pages (assuming books are formatted with page markers or double line breaks)
        const pages = parseBookIntoPages(text);

        if (pageNumber > pages.length || pageNumber < 1) {
            return {
                success: false,
                message: `Page ${pageNumber} not found. Book has ${pages.length} pages.`,
            };
        }

        return {
            success: true,
            data: {
                content: pages[pageNumber - 1],
                totalPages: pages.length,
            },
            message: `Successfully read page ${pageNumber} of ${pages.length}`,
        };
    } catch (err) {
        logger.error('Error reading from storage:', err);
        return { success: false, message: `Error reading book: ${err}` };
    }
}

/**
 * Parse book text into pages
 */
function parseBookIntoPages(text: string): string[] {
    // Check for page markers first
    if (text.includes('[PAGE:')) {
        const pages: string[] = [];
        const pageRegex = /\[PAGE:(\d+)\]([\s\S]*?)(?=\[PAGE:\d+\]|$)/g;
        let match;

        while ((match = pageRegex.exec(text)) !== null) {
            pages[parseInt(match[1]) - 1] = match[2].trim();
        }

        return pages.filter((p) => p); // Remove empty pages
    }

    // Fallback to double line break separation
    return text.split(/\n\s*\n/).filter((page) => page.trim().length > 0);
}

/**
 * Apply reading mode to content
 */
function applyReadingMode(
    content: string,
    mode: string,
    amount: number,
): string {
    switch (mode) {
        case 'paragraphs':
            const paragraphs = content.split('\n').filter((p) => p.trim());
            return paragraphs.slice(0, amount).join('\n\n');

        case 'sentences':
            const sentences = content.match(/[^.!?]+[.!?]+/g) || [];
            return sentences.slice(0, amount).join(' ');

        case 'fullpage':
        default:
            return content;
    }
}

/**
 * Search for books
 */
async function handleSearchMode(
    supabase: SupabaseClient,
    userId: string,
    searchQuery?: string | null,
): Promise<{ success: boolean; data?: any; message: string }> {
    if (!searchQuery) {
        return {
            success: false,
            message:
                "Please specify what you're looking for. Try 'Search for science fiction' or 'Search books by author name'.",
        };
    }

    const { data: books, error } = await supabase
        .from('books')
        .select('*')
        .or(`book_name.ilike.%${searchQuery}%,author.ilike.%${searchQuery}%,description.ilike.%${searchQuery}%`)
        .or(`is_public.eq.true,uploaded_by.eq.${userId}`);

    if (error) {
        return { success: false, message: `Search error: ${error.message}` };
    }

    if (!books || books.length === 0) {
        return {
            success: true,
            data: { results: [] },
            message:
                `No books found matching "${searchQuery}". Try different keywords or browse all books.`,
        };
    }

    let message = `🔍 **Search Results for "${searchQuery}":**\n\n`;

    books.forEach((book, idx) => {
        message += `${idx + 1}. **"${book.book_name}"**`;
        if (book.author) message += ` by ${book.author}`;
        message += `\n`;
        if (book.description) {
            message += `   ${book.description.substring(0, 100)}${
                book.description.length > 100 ? '...' : ''
            }\n`;
        }
        message += `   ${book.total_pages} pages${book.is_public ? '' : ' (Private)'}\n\n`;
    });

    message += "💡 Say 'Start reading [book name]' to begin any book!";

    return {
        success: true,
        data: { results: books },
        message,
    };
}

/**
 * Navigate within a book
 */
async function handleNavigateMode(
    supabase: SupabaseClient,
    userId: string,
    bookId?: string | null,
    action?: string,
    pageNumber?: number | null,
): Promise<{ success: boolean; data?: any; message: string }> {
    if (!bookId) {
        return { success: false, message: 'Please specify which book to navigate.' };
    }

    // Get book and current reading position
    const { data: book } = await supabase
        .from('books')
        .select('*')
        .eq('book_id', bookId)
        .single();

    if (!book) {
        return { success: false, message: 'Book not found.' };
    }

    const { data: history } = await supabase
        .from('reading_history')
        .select('current_page')
        .eq('user_id', userId)
        .eq('book_name', book.book_name)
        .single();

    let targetPage = history?.current_page || 1;

    switch (action) {
        case 'next':
            targetPage = Math.min(targetPage + 1, book.total_pages);
            break;
        case 'previous':
            targetPage = Math.max(targetPage - 1, 1);
            break;
        case 'goto':
            if (pageNumber && pageNumber >= 1 && pageNumber <= book.total_pages) {
                targetPage = pageNumber;
            } else {
                return {
                    success: false,
                    message: `Invalid page number. Book has ${book.total_pages} pages.`,
                };
            }
            break;
        case 'contents':
            // Show table of contents or chapter list if available
            return {
                success: true,
                message:
                    `📑 **"${book.book_name}" Contents:**\n\nTotal pages: ${book.total_pages}\nCurrent position: Page ${
                        history?.current_page || 0
                    }\n\n💡 Say 'Go to page [number]' to jump to any page.`,
            };
    }

    // Read the target page
    const pageContent = await readPageFromStorage(supabase, book.file_path, targetPage);

    if (!pageContent.success) {
        return pageContent;
    }

    // Update reading position
    await supabase
        .from('reading_history')
        .upsert({
            user_id: userId,
            book_name: book.book_name,
            current_page: targetPage,
            total_pages: book.total_pages,
            last_read_at: new Date().toISOString(),
        }, {
            onConflict: 'user_id,book_name',
        });

    // Get reading settings and apply
    const { data: settings } = await supabase
        .from('reading_settings')
        .select('*')
        .eq('user_id', userId)
        .single();

    const processedContent = applyReadingMode(
        pageContent.data.content,
        settings?.reading_mode || 'fullpage',
        settings?.reading_amount || 1,
    );

    return {
        success: true,
        data: {
            book,
            currentPage: targetPage,
            content: processedContent,
        },
        message:
            `📖 **"${book.book_name}" - Page ${targetPage}/${book.total_pages}**\n\n${processedContent}\n\n💡 Say 'Next', 'Previous', or 'Go to page [number]' to navigate.`,
    };
}

/**
 * Handle reading settings
 */
async function handleSettingsMode(
    supabase: SupabaseClient,
    userId: string,
    action: string,
    readingMode?: string | null,
    readingAmount?: number | null,
): Promise<{ success: boolean; data?: any; message: string }> {
    if (action === 'get') {
        const { data: settings } = await supabase
            .from('reading_settings')
            .select('*')
            .eq('user_id', userId)
            .single();

        const currentMode = settings?.reading_mode || 'fullpage';
        const currentAmount = settings?.reading_amount || 1;

        let message = '⚙️ **Your Reading Settings:**\n\n';
        message += `• Reading mode: **${currentMode}**\n`;

        if (currentMode !== 'fullpage') {
            message += `• Amount per page: **${currentAmount} ${currentMode}**\n`;
        }

        message += '\n💡 **Available options:**\n';
        message += "• 'Set reading mode to fullpage' - Read entire pages\n";
        message += "• 'Set reading mode to paragraphs' - Read by paragraphs\n";
        message += "• 'Set reading mode to sentences' - Read by sentences\n";
        message += "• 'Set amount to [number]' - Change how many paragraphs/sentences to read";

        return {
            success: true,
            data: { settings },
            message,
        };
    } else if (action === 'set') {
        if (!readingMode || !['fullpage', 'paragraphs', 'sentences'].includes(readingMode)) {
            return {
                success: false,
                message: 'Invalid reading mode. Choose: fullpage, paragraphs, or sentences.',
            };
        }

        const amount = readingMode === 'fullpage' ? 1 : (readingAmount || 1);

        const { error } = await supabase
            .from('reading_settings')
            .upsert({
                user_id: userId,
                reading_mode: readingMode,
                reading_amount: amount,
                updated_at: new Date().toISOString(),
            }, {
                onConflict: 'user_id',
            });

        if (error) {
            return { success: false, message: `Error updating settings: ${error.message}` };
        }

        let message = `✅ Reading settings updated!\n\n`;
        message += `• Mode: ${readingMode}\n`;
        if (readingMode !== 'fullpage') {
            message += `• Amount: ${amount} ${readingMode} at a time\n`;
        }
        message += '\nThese settings will apply to your next reading session.';

        return {
            success: true,
            message,
        };
    }

    return { success: false, message: 'Invalid settings action.' };
}

/**
 * Handle bookmarks
 */
async function handleBookmarkMode(
    supabase: SupabaseClient,
    userId: string,
    bookId?: string | null,
    action?: string,
    pageNumber?: number | null,
): Promise<{ success: boolean; data?: any; message: string }> {
    // For MVP, we'll use the reading_history table to track bookmarks
    // In a full implementation, you'd want a separate bookmarks table

    if (action === 'add') {
        if (!bookId || !pageNumber) {
            return { success: false, message: 'Please specify which book and page to bookmark.' };
        }

        // For now, we'll just update the current reading position
        const { data: book } = await supabase
            .from('books')
            .select('book_name, total_pages')
            .eq('book_id', bookId)
            .single();

        if (!book) {
            return { success: false, message: 'Book not found.' };
        }

        await supabase
            .from('reading_history')
            .upsert({
                user_id: userId,
                book_name: book.book_name,
                current_page: pageNumber,
                total_pages: book.total_pages,
                last_read_at: new Date().toISOString(),
            }, {
                onConflict: 'user_id,book_name',
            });

        return {
            success: true,
            message:
                `✅ Bookmarked "${book.book_name}" at page ${pageNumber}. Say 'Continue reading' to return to this spot anytime!`,
        };
    }

    return { success: false, message: 'Invalid bookmark action.' };
}
